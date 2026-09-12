#!/usr/bin/env python3
"""
pack_binary.py — canonical JSONL -> two packed binary sections for the browser.

Why two files
-------------
The plan requires autocomplete to work from ~120 KB BEFORE the routing graph downloads.
So the station index is packed on its own and the (much larger) graph separately:

    stations.bin   station names + codes + coords + rank    -> instant autocomplete
    graph.bin      trains + connections                      -> loaded by the worker next

Layout (both files)
-------------------
    Header      32 B   magic "RRLM", version u16, kind u8, flags u8, sectionCount u16,
                       payloadLength u32, contentHash[16] -- the hash is of the inputs,
                       NOT a timestamp (see the determinism note above)
    Directory   20 B x n   one entry per section: id, offset, byteLength, count, itemSize
    Sections     ...       STRINGS (u8 blob) then fixed-width record arrays

Determinism matters: sections are sorted (stations by code, trains by number) and the
header carries a content hash rather than a build timestamp, so rebuilding from the same
canonical data yields a byte-identical file. That makes CI size diffs meaningful instead
of showing a spurious change on every run.

Record layouts
--------------
STATION  12 B   code[5] ascii (space-padded) | nameOff u32 | rank u8 | calls u16
GEO       8 B   lat f32 | lon f32   -- SAME index order as STATION, but shipped in
                graph.bin. Coordinates are only needed for maps, direction preference and
                "places to explore", all of which come after the graph. Keeping them out of
                stations.bin is what pulls first paint from 130 KB to 76 KB gzipped.
TRAIN    32 B   nameOff u32 | numberOff u32 | connStart u32 | connCount u16 |
                durationMin u16 | distanceKm u16 | originStn u16 | destStn u16 |
                classes u16 bitmask | originDepMin u16 | reserved u16 |
                type u8 | runsDays u8 | flags u8 | pad u8

Word layout as seen by the browser's Uint32Array view (8 words):
    w0 nameOff  w1 numberOff  w2 connStart
    w3 connCount | durationMin<<16        w4 distanceKm | originStn<<16
    w5 destStn   | classes<<16            w6 originDepMin | reserved<<16
    w7 type | runsDays<<8 | flags<<16 | pad<<24

Connection times are MINUTES RELATIVE TO THE TRAIN'S ORIGIN DEPARTURE, which is what
keeps them inside a u16. That is fine for routing but useless on screen: a relative
"17:00" reads as 5 pm when it actually means "17 hours after departure". `originDepMin`
is the origin's wall-clock departure (minutes since midnight IST), so the UI can recover
true clock times as (originDepMin + relMin) without paying 4 bytes per connection. 21 KB
across the whole network, and it is the difference between a timetable a human can read
and one they cannot.
CONN     10 B   depMin u16 | arrMin u16 | fromStn u16 | toStn u16 | distKm u16
                (minutes are relative to the train's own origin departure; the worker
                 materialises absolute times per service date, then counting-sorts)

Usage:  python pack_binary.py --canonical data/canonical --out site/public/data
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import struct
import sys
from pathlib import Path

VERSION = 1
KIND_STATIONS, KIND_GRAPH = 1, 2

SEC_STRINGS, SEC_STATIONS, SEC_TRAINS, SEC_CONNECTIONS, SEC_STATION_GEO = 1, 2, 3, 4, 5

STATION_SIZE = 12        # code[5] | nameOff u32 | rank u8 | calls u16
GEO_SIZE = 8             # lat f32 | lon f32
TRAIN_SIZE = 32
CONN_SIZE = 10

HEADER = struct.Struct("<4sHBBHI16s")          # 4+2+1+1+2+4+16 = 30 -> padded to 32
HEADER_PAD = 32
DIRECTORY = struct.Struct("<HHIIIHH")           # id,pad,offset,byteLength,count,itemSize,pad=20

STATION = struct.Struct("<5sIBH")               # 5+4+1+2 = 12
GEO = struct.Struct("<ff")                      # 8
TRAIN = struct.Struct("<IIIHHHHHHHHBBBB")       # 4*3 + 2*8 + 1*4 = 32
CONN = struct.Struct("<HHHHH")                  # 10

CLASS_BIT = {"1A": 1, "2A": 2, "3A": 4, "3E": 8, "SL": 16, "CC": 32,
             "EC": 64, "FC": 128, "2S": 256, "UR": 512}
TYPE_CODES = ["RAJ", "SHT", "DRNT", "GBR", "SVD", "HMS", "VNDB", "SUF", "MEX",
              "PAX", "SPL", "ANT", "JSB", "DDE", "INT"]

FLAG_CLASSES_INFERRED = 1
FLAG_RUNSDAYS_ASSUMED = 2
FLAG_BOOTSTRAP = 4          # dataset predates NTES; UI must show "BOOTSTRAP · 2016"


def log(m: str) -> None:
    print(m, file=sys.stderr, flush=True)


def load_jsonl(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.open() if l.strip()]


class StringTable:
    """Deduplicated UTF-8 blob. Records store a byte offset; strings are NUL-terminated."""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.index: dict[str, int] = {}

    def add(self, s: str) -> int:
        if s in self.index:
            return self.index[s]
        off = len(self.buf)
        self.buf += s.encode("utf-8") + b"\x00"
        self.index[s] = off
        return off


def build_container(kind: int, sections: list[tuple[int, bytes, int, int]],
                    content_hash: bytes, flags: int = 0) -> bytes:
    """
    Assemble header + directory + section payloads.

    Every section starts on a 4-byte boundary so the browser can wrap each one directly in
    a Float32Array/Uint32Array view without copying or hitting an alignment fault.
    """
    dir_len = len(sections) * DIRECTORY.size
    payload_start = (HEADER_PAD + dir_len + 3) & ~3

    body = bytearray()
    directory = bytearray()
    cursor = payload_start
    for sec_id, data, count, item_size in sections:
        directory += DIRECTORY.pack(sec_id, 0, cursor, len(data), count, item_size, 0)
        pad = (-len(data)) % 4
        body += data + b"\x00" * pad
        cursor += len(data) + pad

    header = HEADER.pack(b"RRLM", VERSION, kind, flags & 0xFF, len(sections),
                         len(body), content_hash)
    header += b"\x00" * (HEADER_PAD - len(header))
    assert len(header) == HEADER_PAD
    assert len(directory) == dir_len
    return bytes(header) + bytes(directory) + bytes(body)


def pack(canonical: Path, out: Path) -> dict:
    stations = sorted(load_jsonl(canonical / "stations.jsonl"), key=lambda s: s["code"])
    trains = sorted(load_jsonl(canonical / "trains.jsonl"), key=lambda t: t["number"])
    meta = json.loads((canonical / "meta.json").read_text())

    st_index = {s["code"]: i for i, s in enumerate(stations)}
    if len(stations) > 0xFFFF:
        raise SystemExit(f"FATAL: {len(stations)} stations exceeds the u16 index width")

    # ---------------------------------------------------------- stations.bin
    st_strings = StringTable()
    st_body = bytearray()
    geo_body = bytearray()
    for s in stations:
        code = s["code"].encode("ascii", "replace")[:5].ljust(5, b" ")
        name_off = st_strings.add(s["name"])
        st_body += STATION.pack(code, name_off, s.get("rank", 0),
                                min(0xFFFF, s.get("trainCalls", 0)))
        # Same iteration order, so geo_body[i] describes stations[i].
        geo_body += GEO.pack(s["lat"], s["lon"])

    st_sections = [
        (SEC_STRINGS, bytes(st_strings.buf), len(st_strings.buf), 1),
        (SEC_STATIONS, bytes(st_body), len(stations), STATION_SIZE),
    ]
    st_hash = hashlib.md5(bytes(st_body)).digest()
    stations_bin = build_container(KIND_STATIONS, st_sections, st_hash, FLAG_BOOTSTRAP)

    # ---------------------------------------------------------- graph.bin
    g_strings = StringTable()
    tr_body = bytearray()
    conn_body = bytearray()
    conn_start = 0
    max_conn = max_dur = max_km = 0

    for t in trains:
        stops = t["stops"]
        legs = list(zip(stops, stops[1:]))
        name_off = g_strings.add(t["name"] or t["number"])
        number_off = g_strings.add(t["number"])

        flags = 0
        if t.get("classesInferred"):
            flags |= FLAG_CLASSES_INFERRED
        if t.get("runsDaysAssumed"):
            flags |= FLAG_RUNSDAYS_ASSUMED
        flags |= FLAG_BOOTSTRAP

        classes = 0
        for c in t.get("classes") or []:
            classes |= CLASS_BIT.get(c, 0)
        if not classes:
            classes = CLASS_BIT["SL"] | CLASS_BIT["2S"]

        try:
            type_id = TYPE_CODES.index(t["type"]) + 1
        except ValueError:
            type_id = 0

        dur = int(t["durationMin"])
        km = int(round(t["derivedDistanceKm"]))
        # Wall-clock departure from the origin, recovered from the relative timeline.
        origin_dep = int(t["originDepMinOfDay"]) % 1440
        if origin_dep > 0xFFFF:
            raise SystemExit(f"FATAL: {t['number']} originDepMin={origin_dep} overflows u16")
        max_conn = max(max_conn, len(legs))
        max_dur = max(max_dur, dur)
        max_km = max(max_km, km)
        for field, val, limit in (("durationMin", dur, 0xFFFF),
                                  ("distanceKm", km, 0xFFFF),
                                  ("connCount", len(legs), 0xFFFF)):
            if val > limit:
                raise SystemExit(f"FATAL: {t['number']} {field}={val} overflows u16")

        tr_body += TRAIN.pack(
            name_off, number_off, conn_start, len(legs), dur, km,
            st_index[stops[0]["code"]], st_index[stops[-1]["code"]],
            classes, origin_dep, 0,
            type_id, int(t.get("runsDays", 127)) & 0xFF, flags, 0,
        )

        for a, b in legs:
            conn_body += CONN.pack(
                a["absDep"], b["absArr"], st_index[a["code"]], st_index[b["code"]],
                min(0xFFFF, int(round(b["distKm"]))),
            )
        conn_start += len(legs)

    g_sections = [
        (SEC_STRINGS, bytes(g_strings.buf), len(g_strings.buf), 1),
        (SEC_STATION_GEO, bytes(geo_body), len(stations), GEO_SIZE),
        (SEC_TRAINS, bytes(tr_body), len(trains), TRAIN_SIZE),
        (SEC_CONNECTIONS, bytes(conn_body), conn_start, CONN_SIZE),
    ]
    g_hash = hashlib.md5(bytes(tr_body) + bytes(conn_body) + bytes(geo_body)).digest()
    graph_bin = build_container(KIND_GRAPH, g_sections, g_hash, FLAG_BOOTSTRAP)

    # ---------------------------------------------------------- write + report
    out.mkdir(parents=True, exist_ok=True)
    (out / "stations.bin").write_bytes(stations_bin)
    (out / "graph.bin").write_bytes(graph_bin)

    def gz(b: bytes) -> int:
        return len(gzip.compress(b, 9))

    manifest = {
        "containerVersion": VERSION,
        "source": meta.get("source"),
        "sourceLicence": meta.get("sourceLicence"),
        "schemaVersion": meta.get("schemaVersion"),
        "bootstrap": True,
        "bootstrapLabel": "BOOTSTRAP · 2016",
        "counts": {
            "stations": len(stations),
            "trains": len(trains),
            "connections": conn_start,
        },
        "layout": {
            "header": 32, "directory": 20,
            "STATION": "<5sIBH (12)", "GEO": "<ff (8)",
            "TRAIN": "<IIIHHHHHHBBBB (28)", "CONN": "<HHHHH (10)",
        },
        "limits": {
            "maxLegsPerTrain": max_conn,
            "maxDurationMin": max_dur,
            "maxDistanceKm": max_km,
            "stationIndexWidth": "u16",
        },
        "files": {
            "stations.bin": {
                "bytes": len(stations_bin), "gzipBytes": gz(stations_bin),
                "sha256": hashlib.sha256(stations_bin).hexdigest(),
                "sections": {"STRINGS": len(st_strings.buf), "STATIONS": len(st_body)},
                "recordBytes": STATION_SIZE,
            },
            "graph.bin": {
                "bytes": len(graph_bin), "gzipBytes": gz(graph_bin),
                "sha256": hashlib.sha256(graph_bin).hexdigest(),
                "sections": {"STRINGS": len(g_strings.buf), "STATION_GEO": len(geo_body),
                             "TRAINS": len(tr_body), "CONNECTIONS": len(conn_body)},
                "recordBytes": {"STATION_GEO": GEO_SIZE, "TRAINS": TRAIN_SIZE,
                                "CONNECTIONS": CONN_SIZE},
            },
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--canonical", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    m = pack(args.canonical, args.out)

    print("\n" + "=" * 74)
    print("BINARY PACK REPORT")
    print("=" * 74)
    print(f"  stations={m['counts']['stations']:,}  trains={m['counts']['trains']:,}  "
          f"connections={m['counts']['connections']:,}")
    print(f"  max legs/train={m['limits']['maxLegsPerTrain']}  "
          f"max duration={m['limits']['maxDurationMin'] / 60:.1f}h  "
          f"max distance={m['limits']['maxDistanceKm']:,}km")
    print("-" * 74)
    total_raw = total_gz = 0
    for name, f in m["files"].items():
        total_raw += f["bytes"]
        total_gz += f["gzipBytes"]
        secs = "  ".join(f"{k}={v / 1024:.0f}K" for k, v in f["sections"].items())
        print(f"  {name:<14} {f['bytes'] / 1024:>8.1f} KB   "
              f"gzip {f['gzipBytes'] / 1024:>7.1f} KB   ({secs})")
    print("-" * 74)
    print(f"  {'TOTAL':<14} {total_raw / 1024:>8.1f} KB   gzip {total_gz / 1024:>7.1f} KB")
    print(f"  first paint (stations.bin gz): "
          f"{m['files']['stations.bin']['gzipBytes'] / 1024:.1f} KB  "
          f"[budget 120 KB] {'OK' if m['files']['stations.bin']['gzipBytes'] < 120 * 1024 else 'OVER'}")
    print("=" * 74)
    return 0


if __name__ == "__main__":
    sys.exit(main())
