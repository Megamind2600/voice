#!/usr/bin/env python3
"""
check_packed.py — validate the committed .bin files with NO canonical input and NO node.

Why this exists separately from validate/integrity.py
----------------------------------------------------
integrity.py compares the packed binaries against data/canonical/*.jsonl, which is
gitignored (18 MB, regenerable from 95 MB of raw source). On a clean CI checkout that
input does not exist. This script needs only the two .bin files and manifest.json, so it
can run anywhere in about five seconds — including as the FIRST step of CI, before a
40-second npm install, so a corrupt dataset fails fast instead of after the whole toolchain
has been set up.

It is also the tool to run locally right after regenerating data, when you do not want to
install node_modules just to find out whether the packer produced something sane.

Checks: container magic/version/kind, section alignment, section overlap, declared sizes,
sha256 against the manifest, gzip budgets, and then a full decode of every station, train
and connection record with range and monotonicity assertions.

Usage:  python validate/check_packed.py --bin site/public/data
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import struct
import sys

MAGIC = b"RRLM"
VERSION = 1
KIND_STATIONS, KIND_GRAPH = 1, 2

HDR = struct.Struct("<4sHBBHI16s")     # 30 B packed...
HEADER_PAD = 32                        # ...but the directory starts at 32, so the last 2
                                       # bytes are padding. Using HDR.size here instead of
                                       # HEADER_PAD shifts every directory entry by 2 and
                                       # turns the whole parse into garbage.
DIR = struct.Struct("<HHIIIHH")
STATION = struct.Struct("<5sIBH")
GEO = struct.Struct("<ff")
TRAIN = struct.Struct("<IIIHHHHHHHHBBBB")
CONN = struct.Struct("<HHHHH")

SEC_STRINGS, SEC_STATIONS, SEC_TRAINS, SEC_CONNECTIONS, SEC_GEO = 1, 2, 3, 4, 5

FLAG_BOOTSTRAP = 4
FLAG_RUNSDAYS_ASSUMED = 2
FLAG_CLASSES_INFERRED = 1

FIRST_PAINT_BUDGET = 120 * 1024
GRAPH_BUDGET = 900 * 1024
MAX_STATIONS = 0xFFFF          # station indices are u16 throughout the format

fails: list[str] = []
warns: list[str] = []


def check(ok: bool, label: str, detail: str) -> bool:
    if ok:
        print(f"  [ ok ] {label:<32} {detail}")
    else:
        print(f"  [FAIL] {label:<32} {detail}")
        fails.append(label)
    return ok


def warn(ok: bool, label: str, detail: str) -> None:
    if ok:
        print(f"  [ ok ] {label:<32} {detail}")
    else:
        print(f"  [warn] {label:<32} {detail}")
        warns.append(label)


def parse(raw: bytes, name: str, expect_kind: int) -> tuple[dict, dict]:
    magic, version, kind, flags, nsec, plen, _ = HDR.unpack_from(raw, 0)
    check(magic == MAGIC, f"{name}:magic", f"{magic!r}")
    check(version == VERSION, f"{name}:version", f"{version}")
    check(kind == expect_kind, f"{name}:kind", f"kind={kind} expected={expect_kind}")
    check(HEADER_PAD + nsec * DIR.size + plen <= len(raw) + 3,
          f"{name}:payload_fits", f"declared {plen} B in a {len(raw)} B file")

    sections = {}
    for i in range(nsec):
        at = HEADER_PAD + i * DIR.size
        sid, _p, off, blen, count, isize, _p2 = DIR.unpack_from(raw, at)
        sections[sid] = dict(offset=off, length=blen, count=count, itemSize=isize)
        check(off % 4 == 0, f"{name}:sec{sid}_aligned", f"offset {off}")
        check(off + blen <= len(raw), f"{name}:sec{sid}_inbounds",
              f"{off}+{blen} <= {len(raw)}")
        if isize:
            check(count * isize == blen, f"{name}:sec{sid}_shape",
                  f"{count} x {isize} == {blen}")

    # Sections must not overlap. Alignment and shape checks do NOT catch this: a padding
    # bug computed with a negative modulo yields a file where every declared field is
    # self-consistent yet one section overwrites the tail of the previous one.
    spans = sorted(sections.values(), key=lambda x: x["offset"])
    overlaps = [f"{a['offset']}->{b['offset']}" for a, b in zip(spans, spans[1:])
                if b["offset"] < a["offset"] + a["length"]]
    check(not overlaps, f"{name}:no_overlap", f"{len(overlaps)} overlapping pairs {overlaps[:3]}")
    return sections, dict(flags=flags, kind=kind, version=version)


def cstr(buf: bytes, off: int) -> str:
    end = buf.index(b"\x00", off)
    return buf[off:end].decode("utf-8", "replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True)
    args = ap.parse_args()
    root = args.bin.rstrip("/")

    try:
        st_raw = open(f"{root}/stations.bin", "rb").read()
        gr_raw = open(f"{root}/graph.bin", "rb").read()
        manifest = json.load(open(f"{root}/manifest.json"))
    except FileNotFoundError as e:
        print(f"FATAL: {e}", file=sys.stderr)
        return 2

    print("=" * 78)
    print("PACKED DATASET CHECK  (no canonical input required)")
    print("=" * 78)

    # ---------------------------------------------------------- manifest agreement
    print("\nmanifest")
    for name, raw in (("stations.bin", st_raw), ("graph.bin", gr_raw)):
        meta = manifest["files"][name]
        digest = hashlib.sha256(raw).hexdigest()
        check(digest == meta["sha256"], f"{name}:sha256", digest[:16] + "…")
        check(len(raw) == meta["bytes"], f"{name}:size", f"{len(raw):,} B")
        gz = len(gzip.compress(raw, 9))
        check(abs(gz - meta["gzipBytes"]) <= 64, f"{name}:gzip", f"{gz / 1024:.1f} KB")

    check(manifest.get("bootstrap") is True, "manifest:bootstrap_flag",
          f"bootstrapLabel={manifest.get('bootstrapLabel')!r}")

    # ---------------------------------------------------------- size budgets
    print("\nsize budgets")
    gz_st = len(gzip.compress(st_raw, 9))
    gz_gr = len(gzip.compress(gr_raw, 9))
    check(gz_st <= FIRST_PAINT_BUDGET, "budget:first_paint",
          f"stations.bin {gz_st / 1024:.1f} KB gzip <= {FIRST_PAINT_BUDGET // 1024} KB")
    check(gz_gr <= GRAPH_BUDGET, "budget:graph",
          f"graph.bin {gz_gr / 1024:.1f} KB gzip <= {GRAPH_BUDGET // 1024} KB")
    for name, raw in (("stations.bin", st_raw), ("graph.bin", gr_raw)):
        check(len(raw) < 50 * 1024 * 1024, f"budget:pages_file_limit:{name}",
              f"{len(raw) / 1024 / 1024:.2f} MB < 50 MB")

    # ---------------------------------------------------------- containers
    print("\nstations.bin")
    st_sec, st_hdr = parse(st_raw, "stations", KIND_STATIONS)
    check((st_hdr["flags"] & FLAG_BOOTSTRAP) != 0, "stations:bootstrap_bit",
          f"flags={st_hdr['flags']}")

    print("\ngraph.bin")
    gr_sec, gr_hdr = parse(gr_raw, "graph", KIND_GRAPH)
    check((gr_hdr["flags"] & FLAG_BOOTSTRAP) != 0, "graph:bootstrap_bit",
          f"flags={gr_hdr['flags']}")

    # ---------------------------------------------------------- counts
    print("\ncounts")
    n_st = st_sec[SEC_STATIONS]["count"]
    n_geo = gr_sec[SEC_GEO]["count"]
    n_tr = gr_sec[SEC_TRAINS]["count"]
    n_conn = gr_sec[SEC_CONNECTIONS]["count"]
    check(n_st == manifest["counts"]["stations"], "count:stations", f"{n_st:,}")
    check(n_tr == manifest["counts"]["trains"], "count:trains", f"{n_tr:,}")
    check(n_conn == manifest["counts"]["connections"], "count:connections", f"{n_conn:,}")
    check(n_geo == n_st, "count:geo_matches_stations", f"{n_geo:,} vs {n_st:,}")
    check(n_st <= MAX_STATIONS, "count:station_index_fits_u16",
          f"{n_st:,} <= {MAX_STATIONS:,}")

    # ---------------------------------------------------------- decode stations
    print("\nstation records")
    st_str = st_raw[st_sec[SEC_STRINGS]["offset"]:st_sec[SEC_STRINGS]["offset"] + st_sec[SEC_STRINGS]["length"]]
    st_base = st_sec[SEC_STATIONS]["offset"]
    bad_code = bad_name = bad_rank = 0
    longest = 0
    for i in range(n_st):
        code, name_off, rank, calls = STATION.unpack_from(st_raw, st_base + i * STATION.size)
        longest = max(longest, len(code.rstrip()))
        if not code.rstrip(b" \x00").isascii():
            bad_code += 1
        if calls == 0:
            bad_name += 1                 # a station no train calls at is a dead end
        if rank not in (0, 1, 2, 3):
            bad_rank += 1
        if name_off >= len(st_str):
            bad_name += 1
    check(bad_code == 0, "station:ascii_codes", f"{bad_code} non-ASCII codes")
    check(bad_rank == 0, "station:rank_range", f"{bad_rank} out of 0..3")
    check(bad_name == 0, "station:no_dead_ends",
          f"{bad_name} stations with zero calls or a bad name offset")
    check(longest <= 5, "station:code_width", f"longest code {longest} chars (field is 5)")

    # ---------------------------------------------------------- decode geo
    geo_base = gr_sec[SEC_GEO]["offset"]
    out_of_india = 0
    for i in range(n_geo):
        lat, lon = GEO.unpack_from(gr_raw, geo_base + i * GEO.size)
        if not (5.0 <= lat <= 39.0 and 66.0 <= lon <= 99.0):
            out_of_india += 1
    check(out_of_india == 0, "geo:within_india_bbox", f"{out_of_india} outside")

    # ---------------------------------------------------------- decode trains
    print("\ntrain records")
    gr_str = gr_raw[gr_sec[SEC_STRINGS]["offset"]:gr_sec[SEC_STRINGS]["offset"] + gr_sec[SEC_STRINGS]["length"]]
    tr_base = gr_sec[SEC_TRAINS]["offset"]
    prev_end = 0
    bad_dur = bad_cls = bad_idx = bad_num = bad_contig = assumed = inferred = 0
    max_legs = max_dur = max_km = 0
    for i in range(n_tr):
        (name_off, num_off, cstart, ccount, dur, km, origin, dest,
         classes, origin_dep, _res, ttype, runs, flags, _pad) = TRAIN.unpack_from(
            gr_raw, tr_base + i * TRAIN.size)
        if cstart != prev_end:
            bad_contig += 1               # blocks must be contiguous for binary search
        prev_end = cstart + ccount
        if dur == 0:
            bad_dur += 1
        if classes == 0:
            bad_cls += 1
        if origin >= n_st or dest >= n_st:
            bad_idx += 1
        if num_off >= len(gr_str) or not cstr(gr_str, num_off).strip():
            bad_num += 1
        if origin_dep >= 1440:
            bad_dur += 1                  # wall-clock minutes must be a minute-of-day
        if flags & FLAG_RUNSDAYS_ASSUMED:
            assumed += 1
        if flags & FLAG_CLASSES_INFERRED:
            inferred += 1
        max_legs = max(max_legs, ccount)
        max_dur = max(max_dur, dur)
        max_km = max(max_km, km)

    check(bad_contig == 0, "train:contiguous_blocks",
          f"{bad_contig} gaps (would break connection->train binary search)")
    check(bad_dur == 0, "train:positive_duration", f"{bad_dur} zero/invalid")
    check(bad_cls == 0, "train:has_classes", f"{bad_cls} with an empty class mask")
    check(bad_idx == 0, "train:endpoints_in_range", f"{bad_idx} out of range")
    check(bad_num == 0, "train:number_decodes", f"{bad_num} blank/unreachable")
    check(prev_end == n_conn, "train:legs_sum_to_connections", f"{prev_end:,} vs {n_conn:,}")
    check(assumed == n_tr, "train:runs_days_flagged_assumed",
          f"{assumed:,} of {n_tr:,} carry the assumed bit")
    warn(inferred > 0, "train:classes_inferred",
         f"{inferred:,} trains ({inferred / max(1, n_tr):.0%}) have inferred classes")

    lim = manifest["limits"]
    check(max_legs == lim["maxLegsPerTrain"], "limit:maxLegsPerTrain", f"{max_legs}")
    check(max_dur == lim["maxDurationMin"], "limit:maxDurationMin", f"{max_dur}")
    check(max_km == lim["maxDistanceKm"], "limit:maxDistanceKm", f"{max_km}")
    for label, val in (("maxLegsPerTrain", max_legs), ("maxDurationMin", max_dur),
                       ("maxDistanceKm", max_km)):
        check(val <= 0xFFFF, f"limit:{label}_fits_u16", f"{val}")

    # ---------------------------------------------------------- decode connections
    print("\nconnection records")
    cn_base = gr_sec[SEC_CONNECTIONS]["offset"]
    bad_range = 0
    # Per-train monotonicity: walk each train's contiguous block.
    nonmono_t = nonmono_d = dep_after_arr = 0
    for i in range(n_tr):
        (cstart, ccount) = struct.unpack_from("<IH", gr_raw, tr_base + i * TRAIN.size + 8)
        prev_dep = -1
        prev_km = -1
        for j in range(ccount):
            at = cn_base + (cstart + j) * CONN.size
            if at + CONN.size > len(gr_raw):
                bad_range += 1
                break
            dep, arr, frm, to, km = CONN.unpack_from(gr_raw, at)
            if frm >= n_st or to >= n_st:
                bad_range += 1
            if arr < dep:
                dep_after_arr += 1
            if dep < prev_dep:
                nonmono_t += 1
            if km < prev_km:
                nonmono_d += 1
            prev_dep, prev_km = dep, km

    check(bad_range == 0, "conn:endpoints_in_range", f"{bad_range} bad")
    check(nonmono_t == 0, "conn:monotonic_time", f"{nonmono_t} going backwards in time")
    check(nonmono_d == 0, "conn:monotonic_distance", f"{nonmono_d} going backwards in km")
    check(dep_after_arr == 0, "conn:arr_after_dep", f"{dep_after_arr} arriving before departing")

    # ---------------------------------------------------------- verdict
    print("\n" + "=" * 78)
    print(f"  stations {n_st:,} · trains {n_tr:,} · connections {n_conn:,}")
    print(f"  stations.bin {len(st_raw) / 1024:.1f} KB -> {gz_st / 1024:.1f} KB gzip")
    print(f"  graph.bin    {len(gr_raw) / 1024:.1f} KB -> {gz_gr / 1024:.1f} KB gzip")
    print("-" * 78)
    print(f"  FAILURES: {len(fails)}    warnings: {len(warns)}")
    if fails:
        for f in fails:
            print(f"    !! {f}", file=sys.stderr)
    print("=" * 78)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
