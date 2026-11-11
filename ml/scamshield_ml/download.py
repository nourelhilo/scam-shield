"""Download the pinned datasets and verify their SHA-256 digests.

Usage (from the ml/ directory):  python -I -m scamshield_ml.download

Files are written to ml/data/raw/<source id>/. A file whose digest does not match the
pinned value is deleted and the command fails: we never train on unverified data.
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

from .paths import RAW_DIR
from .sources import SOURCES, SourceFile

MAX_BYTES = 100 * 1024 * 1024  # no single pinned file is larger than ~31 MB
USER_AGENT = "scamshield-dataset-fetch/1.0"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(file: SourceFile, dest: Path) -> None:
    if dest.exists() and sha256_file(dest) == file.sha256:
        print(f"ok (cached)  {dest.relative_to(RAW_DIR)}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(file.url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response, tmp.open("wb") as out:
        total = 0
        while chunk := response.read(1 << 20):
            total += len(chunk)
            if total > MAX_BYTES:
                raise RuntimeError(f"{file.url} exceeded the {MAX_BYTES} byte limit")
            out.write(chunk)
    digest = sha256_file(tmp)
    if digest != file.sha256:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"SHA-256 mismatch for {file.filename}: expected {file.sha256}, got {digest}")
    tmp.replace(dest)
    print(f"downloaded   {dest.relative_to(RAW_DIR)}")


def main() -> int:
    failures = 0
    for source in SOURCES:
        for file in source.files:
            try:
                fetch(file, RAW_DIR / source.id / file.filename)
            except Exception as exc:  # report every failure, then exit non-zero
                failures += 1
                print(f"FAILED       {source.id}/{file.filename}: {exc}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
