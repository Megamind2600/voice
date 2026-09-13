#!/usr/bin/env python3
"""Dump the packed station index as TSV: code, name, rank, calls, lat, lon.

Development helper for the destination notes in `site/public/data/profiles.json` — it is the
fastest way to check that a station CODE actually exists in the packed dataset before writing it
into a profile, and it is what `site/tests/profiles.test.ts` does programmatically with the same
fields (a code that does not resolve is a profile that is silently unreachable).

    python harvester/places/station_dump.py [site/public/data]
"""
from __future__ import annotations
import struct, sys
from pathlib import Path

HEADER_PAD, DIRECTORY = 32, struct.Struct("<HHIIIHH")

def sections(path: Path) -> dict[int, tuple[bytes, int, int]]:
    buf = path.read_bytes()
    (count,) = struct.unpack_from("<H", buf, 6)
    out = {}
    for i in range(count):
        sec_id, _pad, off, length, cnt, item, _pad2 = DIRECTORY.unpack_from(buf, HEADER_PAD + i * DIRECTORY.size)
        out[sec_id] = (buf[off:off + length], cnt, item)
    return out

def cstr(blob: bytes, off: int) -> str:
    end = blob.index(b"\x00", off)
    return blob[off:end].decode("utf-8", "replace")

def main() -> None:
    data = Path(sys.argv[1] if len(sys.argv) > 1 else "site/public/data")
    st = sections(data / "stations.bin")
    geo_blob, _, _ = sections(data / "graph.bin")[5]
    strings = st[1][0]
    rec, cnt, _ = st[2]
    geo = struct.unpack(f"<{len(geo_blob)//4}f", geo_blob)
    for i in range(cnt):
        code_b, name_off, rank, calls = struct.unpack_from("<5sIBH", rec, i * 12)
        code = code_b.decode("ascii").strip()
        name = cstr(strings, name_off)
        lat, lon = geo[i * 2], geo[i * 2 + 1]
        print(f"{code}\t{name}\t{rank}\t{calls}\t{lat:.4f}\t{lon:.4f}")

if __name__ == "__main__":
    main()
