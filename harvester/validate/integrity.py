#!/usr/bin/env python3
"""
integrity.py — hard gate over the canonical dataset.

Run in CI after normalise/pack. Exits non-zero if any HARD check fails, so a corrupt
dataset can never reach GitHub Pages. WARN checks are reported but do not fail the build.

The point of this file is that a routing graph fails QUIETLY: a single reversed departure
time does not crash anything, it just silently produces itineraries that are impossible to
travel. Every check below exists because that class of bug is invisible in the UI.

Usage:  python validate/integrity.py --canonical data/canonical [--bin site/public/data/graph.bin]
"""
from __future__ import annotations

import argparse
import gzip
import json
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

HARD, WARN = "HARD", "WARN"

# Physical limits for Indian Railways (2016-era rolling stock).
MAX_AVG_KMH = 160.0      # fastest scheduled average is well under this
MAX_DURATION_H = 130.0   # longest real Indian journey (Vivek Exp) is ~85 h
MAX_HALT_MIN = 720       # a 12-hour halt means the day reconstruction went wrong
MAX_ROUTE_STATIONS = 1400


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, int]] = []   # severity, check, detail, count

    def add(self, sev: str, check: str, detail: str, count: int = 0) -> None:
        self.rows.append((sev, check, detail, count))

    @property
    def failed(self) -> bool:
        return any(r[0] == HARD and r[3] > 0 for r in self.rows)

    def emit(self) -> None:
        w = max((len(r[1]) for r in self.rows), default=10)
        print("\n" + "=" * 78)
        print("INTEGRITY REPORT")
        print("=" * 78)
        for sev, check, detail, count in self.rows:
            mark = "FAIL" if (sev == HARD and count > 0) else ("warn" if count else " ok ")
            print(f"  [{mark}] {check:<{w}}  {detail}")
        hard = [r for r in self.rows if r[0] == HARD and r[3] > 0]
        warn = [r for r in self.rows if r[0] == WARN and r[3] > 0]
        print("-" * 78)
        print(f"  HARD failures: {len(hard)}    warnings: {len(warn)}")
        print("=" * 78)
        if hard:
            for _, check, detail, count in hard:
                print(f"  !! {check}: {detail}", file=sys.stderr)


# --------------------------------------------------------------------- binary container

MAGIC = b"RRLM"
HDR = struct.Struct("<4sHBBHI16s")     # 30 B, padded to 32
DIR = struct.Struct("<HHIIIHH")        # 20 B
STATION = struct.Struct("<5sIBH")      # 12 B
GEO = struct.Struct("<ff")             # 8 B
TRAIN = struct.Struct("<IIIHHHHHHHHBBBB")  # 32 B
CONN = struct.Struct("<HHHHH")         # 10 B

FIRST_PAINT_BUDGET = 120 * 1024
MAX_FILE_BUDGET = 50 * 1024 * 1024     # GitHub Pages warns above this per file


def read_container(path: Path) -> tuple[dict, bytes]:
    raw = path.read_bytes()
    magic, version, kind, flags, nsec, plen, chash = HDR.unpack_from(raw, 0)
    if magic != MAGIC:
        raise ValueError(f"{path.name}: bad magic {magic!r}")
    sections = {}
    for i in range(nsec):
        sid, _pad, off, blen, count, isize, _p2 = DIR.unpack_from(raw, 32 + i * DIR.size)
        sections[sid] = dict(offset=off, length=blen, count=count, itemSize=isize)
    return dict(version=version, kind=kind, flags=flags, sections=sections,
                payloadLength=plen, raw=raw), raw


def verify_binary(bin_dir: Path, stations_in: list[dict], trains_in: list[dict],
                  rpt: "Report") -> None:
    # The packer emits sections in a DEFINED order (stations by code, trains by number)
    # that is not the JSONL's insertion order. Sort identically before comparing, and use
    # the sorted position as the station index -- that index is what every train record
    # and connection actually references.
    stations = sorted(stations_in, key=lambda s: s["code"])
    trains = sorted(trains_in, key=lambda t: t["number"])

    st_path, gr_path = bin_dir / "stations.bin", bin_dir / "graph.bin"
    if not st_path.exists() or not gr_path.exists():
        rpt.add(HARD, "bin:missing", f"{st_path} / {gr_path} not found", 1)
        return

    st, _ = read_container(st_path)
    gr, _ = read_container(gr_path)
    raw_st = st_path.read_bytes()
    raw_gr = gr_path.read_bytes()

    rpt.add(HARD, "bin:kind", f"stations.bin kind={st['kind']} graph.bin kind={gr['kind']}",
            0 if (st["kind"] == 1 and gr["kind"] == 2) else 1)

    # ---- sizes against the budgets in docs/03 ----
    gz_st = len(gzip.compress(raw_st, 9))
    gz_gr = len(gzip.compress(raw_gr, 9))
    rpt.add(HARD, "bin:first_paint_budget",
            f"stations.bin gzip={gz_st / 1024:.1f} KB (budget {FIRST_PAINT_BUDGET // 1024} KB)",
            0 if gz_st <= FIRST_PAINT_BUDGET else 1)
    over = [n for n, b in (("stations.bin", len(raw_st)), ("graph.bin", len(raw_gr)))
            if b > MAX_FILE_BUDGET]
    rpt.add(HARD, "bin:pages_file_limit",
            f"largest file {max(len(raw_st), len(raw_gr)) / 1024 / 1024:.2f} MB "
            f"(Pages warns at 50 MB)" + (f" OVER: {over}" if over else ""), len(over))

    # ---- alignment: typed-array views must not need a copy ----
    misaligned = [sid for sid, sec in list(st["sections"].items()) + list(gr["sections"].items())
                  if sec["offset"] % 4 != 0]
    rpt.add(HARD, "bin:alignment",
            f"{len(misaligned)} sections not 4-byte aligned {misaligned}", len(misaligned))

    # ---- sections must not overlap ----
    # The alignment and count*itemSize checks above do NOT catch this. A packing bug that
    # computes section padding with a negative modulo produces a file where every declared
    # field is self-consistent, yet one section overwrites the tail of the previous one and
    # every string near the boundary decodes to garbage. Caught by the JS test suite once;
    # guarded here so it cannot ship.
    overlaps = []
    for name, cont in (("stations.bin", st), ("graph.bin", gr)):
        spans = sorted(cont["sections"].values(), key=lambda x: x["offset"])
        for a, b in zip(spans, spans[1:]):
            if b["offset"] < a["offset"] + a["length"]:
                overlaps.append(f"{name}: sec{a['id']} -> sec{b['id']}")
    rpt.add(HARD, "bin:section_overlap",
            f"{len(overlaps)} overlapping section pairs {overlaps[:4]}", len(overlaps))

    # ---- counts must match the canonical data ----
    n_st = st["sections"][2]["count"]
    n_geo = gr["sections"][5]["count"]
    n_tr = gr["sections"][3]["count"]
    n_conn = gr["sections"][4]["count"]
    exp_conn = sum(len(t["stops"]) - 1 for t in trains)
    rpt.add(HARD, "bin:counts",
            f"stations {n_st} (exp {len(stations)}), geo {n_geo}, trains {n_tr} "
            f"(exp {len(trains)}), connections {n_conn} (exp {exp_conn})",
            0 if (n_st == len(stations) and n_tr == len(trains)
                  and n_conn == exp_conn and n_geo == n_st) else 1)

    # ---- round-trip EVERY station record back to the canonical data ----
    buf_st = raw_st
    str_off = st["sections"][1]["offset"]
    rec_off = st["sections"][2]["offset"]
    mismatch = []
    for i, expect in enumerate(stations):
        code, name_off, rank, calls = STATION.unpack_from(buf_st, rec_off + i * STATION.size)
        end = buf_st.index(b"\x00", str_off + name_off)
        name = buf_st[str_off + name_off:end].decode("utf-8")
        got = code.decode("ascii").strip()
        if (got != expect["code"] or name != expect["name"]
                or rank != expect["rank"] or calls != expect["trainCalls"]):
            mismatch.append(expect["code"])
    rpt.add(HARD, "bin:station_roundtrip",
            f"{len(mismatch)} of {len(stations)} station records differ from canonical "
            f"e.g. {mismatch[:5]}", len(mismatch))

    # ---- round-trip coordinates ----
    geo_off = gr["sections"][5]["offset"]
    geo_bad = []
    for i, expect in enumerate(stations):
        lat, lon = GEO.unpack_from(raw_gr, geo_off + i * GEO.size)
        if abs(lat - expect["lat"]) > 1e-4 or abs(lon - expect["lon"]) > 1e-4:
            geo_bad.append(expect["code"])
    rpt.add(HARD, "bin:geo_roundtrip",
            f"{len(geo_bad)} coordinates lost precision e.g. {geo_bad[:5]}", len(geo_bad))

    # ---- round-trip every train header and its connection block ----
    tstr_off = gr["sections"][1]["offset"]
    tr_off = gr["sections"][3]["offset"]
    cn_off = gr["sections"][4]["offset"]
    # code -> position in the SORTED station array, which is the index space used by
    # TRAIN.originStn/destStn and CONN.fromStn/toStn.
    st_by_code = {s["code"]: i for i, s in enumerate(stations)}
    tr_bad, conn_bad, oob = [], [], 0

    for i, expect in enumerate(trains):
        (name_off, num_off, cstart, ccount, dur, km, origin, dest,
         classes, origin_dep, _reserved, ttype, runs, flags, _pad) = TRAIN.unpack_from(
            raw_gr, tr_off + i * TRAIN.size)
        e = raw_gr.index(b"\x00", tstr_off + num_off)
        number = raw_gr[tstr_off + num_off:e].decode("utf-8")
        if number != expect["number"]:
            tr_bad.append(expect["number"])
        stops = expect["stops"]
        if ccount != len(stops) - 1:
            tr_bad.append(f"{expect['number']}:ccount")
        if dur != expect["durationMin"] or origin != st_by_code[stops[0]["code"]] \
                or dest != st_by_code[stops[-1]["code"]] \
                or origin_dep != expect["originDepMinOfDay"] % 1440:
            tr_bad.append(f"{expect['number']}:fields")
        if flags & 4 == 0:
            tr_bad.append(f"{expect['number']}:bootstrap_flag")

        for j, (a, b) in enumerate(zip(stops, stops[1:])):
            pos = cn_off + (cstart + j) * CONN.size
            if pos + CONN.size > len(raw_gr):
                oob += 1
                break
            dep, arr, frm, to, dkm = CONN.unpack_from(raw_gr, pos)
            if (dep != a["absDep"] or arr != b["absArr"]
                    or frm != st_by_code[a["code"]] or to != st_by_code[b["code"]]
                    or abs(dkm - round(b["distKm"])) > 1):
                conn_bad.append(f"{expect['number']}#{j}")

    rpt.add(HARD, "bin:train_roundtrip",
            f"{len(tr_bad)} train header mismatches e.g. {tr_bad[:5]}", len(tr_bad))
    rpt.add(HARD, "bin:conn_roundtrip",
            f"{len(conn_bad)} of {exp_conn:,} connections mismatch e.g. {conn_bad[:5]}",
            len(conn_bad))
    rpt.add(HARD, "bin:conn_out_of_bounds", f"{oob} connection reads past end of file", oob)

    rpt.rows.append((WARN, "bin:sizes",
                     f"stations.bin {len(raw_st) / 1024:.1f} KB -> {gz_st / 1024:.1f} KB gz; "
                     f"graph.bin {len(raw_gr) / 1024:.1f} KB -> {gz_gr / 1024:.1f} KB gz", 0))

def load_jsonl(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.open() if l.strip()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--canonical", required=True, type=Path)
    ap.add_argument("--bin", type=Path, default=None)
    args = ap.parse_args()

    rpt = Report()
    stations = load_jsonl(args.canonical / "stations.jsonl")
    trains = load_jsonl(args.canonical / "trains.jsonl")
    meta = json.loads((args.canonical / "meta.json").read_text())

    st_by_code = {s["code"]: s for s in stations}
    counts = Counter()

    # ---------------------------------------------------------- volume / non-empty
    rpt.add(HARD, "volume", f"{len(trains)} trains, {len(stations)} stations "
                            f"(min 1000 / 500)",
            0 if len(trains) >= 1000 and len(stations) >= 500 else 1)

    # ---------------------------------------------------------- station integrity
    dupes = len(stations) - len(st_by_code)
    rpt.add(HARD, "station:dup_codes", f"{dupes} duplicate station codes", dupes)

    no_geo = [s["code"] for s in stations if not (-90 <= s["lat"] <= 90 and -180 <= s["lon"] <= 180)]
    rpt.add(HARD, "station:bad_coords", f"{len(no_geo)} out of range e.g. {no_geo[:3]}", len(no_geo))

    # India bbox + 50 km slack
    outside = [s["code"] for s in stations
               if not (5.0 <= s["lat"] <= 39.0 and 66.0 <= s["lon"] <= 99.0)]
    rpt.add(WARN, "station:outside_india", f"{len(outside)} outside India bbox e.g. {outside[:5]}",
            len(outside))

    no_name = [s["code"] for s in stations if not (s.get("name") or "").strip()]
    rpt.add(HARD, "station:blank_name", f"{len(no_name)} blank names", len(no_name))

    bad_rank = [s["code"] for s in stations if s.get("rank") not in (0, 1, 2, 3)]
    rpt.add(HARD, "station:bad_rank", f"{len(bad_rank)} invalid rank", len(bad_rank))

    # ---------------------------------------------------------- referential integrity
    unknown = set()
    for t in trains:
        for s in t["stops"]:
            if s["code"] not in st_by_code:
                unknown.add(s["code"])
    rpt.add(HARD, "ref:unknown_station", f"{len(unknown)} stop codes missing from stations.jsonl "
                                         f"e.g. {sorted(unknown)[:5]}", len(unknown))

    # ---------------------------------------------------------- per-train invariants
    nonmono_dep = nonmono_dist = dep_lt_arr = neg_dur = over_dur = over_speed = 0
    over_halt = dup_stop = short = empty_cls = no_origin = 0
    dur_list, spd_list, stop_list = [], [], []
    worst_speed, worst_dur = None, None

    for t in trains:
        stops = t["stops"]
        if len(stops) < 2:
            short += 1
            continue
        counts["stops"] += len(stops)

        deps = [s["absDep"] for s in stops]
        arrs = [s["absArr"] for s in stops]
        dists = [s["distKm"] for s in stops]

        if any(b < a for a, b in zip(deps, deps[1:])):
            nonmono_dep += 1
        if any(b < a for a, b in zip(dists, dists[1:])):
            nonmono_dist += 1
        if any(s["absDep"] < s["absArr"] for s in stops):
            dep_lt_arr += 1
        if any(s["absArr"] is None or s["absDep"] is None for s in stops):
            no_origin += 1
        if any(s["haltMin"] > MAX_HALT_MIN for s in stops):
            over_halt += 1
        if len({s["code"] for s in stops}) != len(stops):
            dup_stop += 1
        if not t.get("classes"):
            empty_cls += 1
        if stops[0]["distKm"] != 0:
            counts["origin_not_zero_km"] += 1

        dur_min = t["durationMin"]
        dur_h = dur_min / 60
        dur_list.append(dur_h)
        stop_list.append(len(stops))
        if dur_min <= 0:
            neg_dur += 1
        if dur_h > MAX_DURATION_H:
            over_dur += 1
            if worst_dur is None or dur_h > worst_dur[1]:
                worst_dur = (t["number"], dur_h)

        km = stops[-1]["distKm"]
        if dur_h > 0.25 and km > 20:
            spd = km / dur_h
            spd_list.append(spd)
            if spd > MAX_AVG_KMH:
                over_speed += 1
                if worst_speed is None or spd > worst_speed[1]:
                    worst_speed = (t["number"], round(spd, 1))
        if len(stops) > MAX_ROUTE_STATIONS:
            counts["over_max_stations"] += 1

        # derived distance must agree with the source's own stated distance
        stated = t.get("distanceKm") or 0
        if stated > 100:
            rel = abs(t["derivedDistanceKm"] - stated) / stated
            counts["dist_checked"] += 1
            if rel > 0.35:
                counts["dist_off_35pct"] += 1

    rpt.add(HARD, "train:nonmono_departure", f"{nonmono_dep} trains leave a station before "
                                             f"reaching the previous one", nonmono_dep)
    rpt.add(HARD, "train:nonmono_distance", f"{nonmono_dist} trains with decreasing cumulative km",
            nonmono_dist)
    rpt.add(HARD, "train:dep_before_arr", f"{dep_lt_arr} trains departing before arriving", dep_lt_arr)
    rpt.add(HARD, "train:null_times", f"{no_origin} trains with a null arrival/departure", no_origin)
    rpt.add(HARD, "train:nonpositive_duration", f"{neg_dur} trains with duration <= 0", neg_dur)
    rpt.add(HARD, "train:too_few_stops", f"{short} trains with < 2 stops", short)
    rpt.add(HARD, "train:duplicate_stop", f"{dup_stop} trains visiting a station twice "
                                          f"(legitimate for some loops; investigate)", dup_stop)

    rpt.add(WARN, "train:over_max_duration",
            f"{over_dur} exceed {MAX_DURATION_H:.0f}h"
            + (f" worst={worst_dur[0]} at {worst_dur[1]:.0f}h" if worst_dur else ""), over_dur)
    rpt.add(WARN, "train:over_max_speed",
            f"{over_speed} average > {MAX_AVG_KMH:.0f} km/h"
            + (f" worst={worst_speed[0]} at {worst_speed[1]} km/h" if worst_speed else ""), over_speed)
    rpt.add(WARN, "train:excessive_halt", f"{over_halt} trains with a halt > {MAX_HALT_MIN} min",
            over_halt)
    rpt.add(WARN, "train:no_classes", f"{empty_cls} trains with an empty class list "
                                      f"(falls back to UR/SL default)", empty_cls)
    rpt.add(WARN, "distance:off_35pct",
            f"{counts['dist_off_35pct']} of {counts['dist_checked']} checked trains differ "
            f">35% from the source's stated distance", counts["dist_off_35pct"])

    # ---------------------------------------------------------- network connectivity
    # Union-Find over consecutive stops of every train. A rail network should be ONE
    # giant component; extra components are islands you can reach but never leave, which
    # is exactly the kind of thing that makes discovery mode return nothing.
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    calls: Counter = Counter()
    for t in trains:
        codes = [s["code"] for s in t["stops"]]
        for c in codes:
            calls[c] += 1
        for a, b in zip(codes, codes[1:]):
            union(a, b)

    comps: dict[str, int] = defaultdict(int)
    for c in st_by_code:
        comps[find(c)] += 1
    sizes = sorted(comps.values(), reverse=True)
    giant = sizes[0] if sizes else 0
    orphans = sum(1 for s in sizes[1:] if s == 1)
    rpt.add(WARN, "net:components",
            f"{len(sizes)} components; giant={giant} ({giant / max(1, len(st_by_code)):.1%}), "
            f"{orphans} single-station islands",
            1 if giant < 0.5 * len(st_by_code) else 0)

    transfer = sum(1 for c, n in calls.items() if n >= 2)
    rpt.add(HARD, "net:transfer_stations",
            f"{transfer} stations served by >=2 trains "
            f"({transfer / max(1, len(st_by_code)):.1%}) — needed for any multi-leg itinerary",
            0 if transfer >= 500 else 1)

    unreachable = [s["code"] for s in stations if calls.get(s["code"], 0) == 0]
    rpt.add(WARN, "net:stations_never_called",
            f"{len(unreachable)} stations are in the index but no train stops "
            f"(autocomplete will offer dead ends) e.g. {unreachable[:5]}", len(unreachable))

    # ---------------------------------------------------------- packed binary
    if args.bin:
        verify_binary(args.bin, stations, trains, rpt)

    rpt.emit()

    summary = {
        "passed": not rpt.failed,
        "counts": {
            "trains": len(trains),
            "stations": len(stations),
            "stops": counts["stops"],
            "medianStopsPerTrain": sorted(stop_list)[len(stop_list) // 2] if stop_list else 0,
            "medianDurationH": round(sorted(dur_list)[len(dur_list) // 2], 2) if dur_list else 0,
            "medianAvgKmh": round(sorted(spd_list)[len(spd_list) // 2], 1) if spd_list else 0,
            "p95AvgKmh": round(sorted(spd_list)[int(0.95 * len(spd_list))], 1) if spd_list else 0,
            "transferStations": transfer,
            "networkComponents": len(sizes),
            "giantComponentStations": giant,
            "stationsNeverCalled": len(unreachable),
        },
        "hardFailures": [r[1] for r in rpt.rows if r[0] == HARD and r[3] > 0],
        "warnings": [r[1] for r in rpt.rows if r[0] == WARN and r[3] > 0],
        "meta": {k: meta.get(k) for k in ("schemaVersion", "source", "railDetourFactor")},
    }
    (args.canonical / "integrity.json").write_text(json.dumps(summary, indent=2))
    print("\n" + json.dumps(summary, indent=2))
    return 1 if rpt.failed else 0


if __name__ == "__main__":
    sys.exit(main())
