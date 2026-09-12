#!/usr/bin/env python3
"""
fetch_seed.py — pull the CC0 bootstrap dataset WITHOUT spending an Actions minute.

This is the "zero-Actions bootstrap" described in docs/03-architecture-and-build.md §7.
The dataset is fetched once, locally, by a human; only the small packed derivative is
committed. The 82 MB raw schedules.json never enters Git (Pages rejects files over
100 MB and warns over 50 MB) and no workflow ever downloads it.

Why `git clone` and not an HTTPS file download
----------------------------------------------
A shallow sparse clone lets us materialise exactly three files and nothing else, and it
works in network environments where raw.githubusercontent.com is blocked or rate-limited
while github.com itself is allowed. It is also resumable and verifiable against a commit
sha, which a bare file download is not.

Usage:
    python fetch_seed.py --out data/raw
    python fetch_seed.py --out data/raw --pin <commit-sha>   # reproducible re-fetch
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = "https://github.com/datameet/railways.git"
FILES = ["stations.json", "trains.json", "schedules.json", "README.md"]
LICENCE = "CC0"


def log(m: str) -> None:
    print(m, file=sys.stderr, flush=True)


def run(cmd: list[str], cwd: Path | None = None) -> str:
    log("  $ " + " ".join(cmd))
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"command failed ({r.returncode}):\n{r.stdout}\n{r.stderr}")
    return r.stdout.strip()


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--pin", default=None, help="commit sha to check out (reproducibility)")
    ap.add_argument("--keep-clone", action="store_true", help="do not delete the temp clone")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="railseed-"))
    log(f"[1/3] shallow sparse clone -> {tmp}")
    try:
        run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", REPO, str(tmp / "repo")])
        repo = tmp / "repo"
        run(["git", "sparse-checkout", "set", "--no-cone", "/"], cwd=repo)
        head = run(["git", "rev-parse", "HEAD"], cwd=repo)
        if args.pin:
            run(["git", "checkout", args.pin], cwd=repo)
            head = args.pin
        log(f"      HEAD = {head}")

        log("[2/3] copying files")
        manifest = {"source": REPO, "commit": head, "licence": LICENCE, "files": {}}
        for name in FILES:
            src = repo / name
            if not src.exists():
                raise SystemExit(f"expected {name} in the repository but it is missing")
            dst = args.out / name
            shutil.copy2(src, dst)
            size = dst.stat().st_size
            digest = sha256(dst)
            manifest["files"][name] = {"bytes": size, "sha256": digest}
            log(f"      {name:<16} {size / 1e6:8.2f} MB  {digest[:16]}…")

        log("[3/3] writing manifest")
        (args.out / "seed-manifest.json").write_text(json.dumps(manifest, indent=2))

        # Guard the Git size limit explicitly: never let a raw file be committed.
        too_big = [n for n, f in manifest["files"].items() if f["bytes"] > 45 * 1024 * 1024]
        print("\n" + "=" * 70)
        print("SEED FETCH REPORT")
        print("=" * 70)
        print(f"  commit    {head}")
        print(f"  licence   {LICENCE} (redistributable, attribution appreciated)")
        for n, f in manifest["files"].items():
            print(f"  {n:<16} {f['bytes'] / 1e6:8.2f} MB")
        print("-" * 70)
        print(f"  DO NOT COMMIT: {', '.join(too_big) if too_big else '(none)'}")
        print("  These exceed the 45 MB safety margin below GitHub's 50 MB warning.")
        print("  data/raw/ is gitignored; only the packed derivative is committed.")
        print("=" * 70)
        return 0
    finally:
        if not args.keep_clone:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
