"""Convert board-recog v1 PNG dataset → HDF5 per-split (KS-3080, runbook §9.5).

`v1/` стороны: ~1 M PNG-файлов в `cells/<style>/<bucket>/<fen>_<sq>.png` +
`splits/{train,val,test}.jsonl`. На S3 это миллион мелких объектов и
`aws s3 sync v1/` занимает ~4.5 часа.

Этот скрипт собирает три HDF5-файла `cells_{train,val,test}.h5` (по одному
dataset `cells` типа `vlen(uint8)` с PNG-байтами) и переписывает каждый
`splits/<split>.jsonl` с новым полем `"idx"`, указывающим на позицию клетки
в HDF5. После заливки в `s3://kingside-ml/datasets/board-recog/v1-h5/`
доставка ~4 ГБ на g4dn.xlarge — ~3 минуты вместо 4.5 часов.

`v1/` НЕ удаляем — он остаётся source-of-truth (runbook §9.4).

## Использование

    python -m training.convert_v1_to_h5 \\
        --data-dir   /work/v1 \\
        --output-dir /work/v1-h5 \\
        --workers    8

`--data-dir` должен содержать `cells/`, `splits/`, `manifest_v1.json`.
`--output-dir` создаётся, если нет. `--workers` управляет параллельным
чтением PNG-файлов с диска (запись в HDF5 — однопоточная, h5py не
fork-safe для записи).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


SPLITS = ("train", "val", "test")


def _read_split(src: Path, split: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    split_path = src / "splits" / f"{split}.jsonl"
    if not split_path.is_file():
        raise FileNotFoundError(f"split file not found: {split_path}")
    with split_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _read_one_png(src: Path, row: Dict[str, Any]) -> bytes:
    return (src / row["path"]).read_bytes()


def _sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            buf = fh.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def _human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KiB"
    if n < 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MiB"
    return f"{n / (1024 * 1024 * 1024):.2f} GiB"


def convert_split(
    src: Path,
    dst: Path,
    split: str,
    workers: int,
    log_every: int = 5_000,
) -> Dict[str, Any]:
    """Read all rows of one split, pack PNG bytes into a vlen(uint8) HDF5
    dataset, rewrite splits/<split>.jsonl with the new `idx` field.

    Returns a dict with summary stats (cells/sec, size, sha256).
    """
    # Lazy h5py + numpy imports keep `--help` usable without the deps.
    import h5py
    import numpy as np

    rows = _read_split(src, split)
    n = len(rows)
    print(f"[{split}] {n} cells in JSONL", file=sys.stderr)

    h5_path = dst / f"cells_{split}.h5"
    h5_path.parent.mkdir(parents=True, exist_ok=True)
    vlen_u8 = h5py.vlen_dtype(np.dtype("uint8"))

    # Reads can saturate the disk; writes stay in the main thread because
    # h5py is *not* thread-safe for writes and Python file ops in h5py are
    # serialized through the GIL anyway. The pool only does `read_bytes()`.
    start = time.time()
    last_log_at = start
    bytes_read = 0
    with h5py.File(h5_path, "w") as f:
        cells = f.create_dataset(
            "cells",
            shape=(n,),
            dtype=vlen_u8,
            chunks=True,
        )
        f.attrs["num_cells"] = n
        f.attrs["split"] = split
        f.attrs["source"] = "board-recog v1"
        f.attrs["created_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        if workers <= 1:
            for i, row in enumerate(rows):
                data = _read_one_png(src, row)
                cells[i] = np.frombuffer(data, dtype=np.uint8)
                row["idx"] = i
                bytes_read += len(data)
                if (i + 1) % log_every == 0 or i + 1 == n:
                    now = time.time()
                    rate = log_every / max(now - last_log_at, 0.001)
                    last_log_at = now
                    print(
                        f"[{split}] {i + 1:>7}/{n} ({rate:.0f} cells/s, "
                        f"read {_human_bytes(bytes_read)})",
                        file=sys.stderr,
                    )
        else:
            # Submit reads in a sliding window equal to `workers` so we
            # don't queue a million futures at once.
            window = max(workers * 4, 64)
            written = 0
            with ThreadPoolExecutor(max_workers=workers) as pool:
                idx = 0
                in_flight: Dict[int, Any] = {}

                def submit_next() -> None:
                    nonlocal idx
                    while idx < n and len(in_flight) < window:
                        fut = pool.submit(_read_one_png, src, rows[idx])
                        in_flight[idx] = fut
                        idx += 1

                submit_next()
                # Write in row order so h5 dataset indices == JSONL row order.
                while written < n:
                    fut = in_flight.pop(written)
                    data = fut.result()
                    cells[written] = np.frombuffer(data, dtype=np.uint8)
                    rows[written]["idx"] = written
                    bytes_read += len(data)
                    written += 1
                    submit_next()
                    if written % log_every == 0 or written == n:
                        now = time.time()
                        rate = log_every / max(now - last_log_at, 0.001)
                        last_log_at = now
                        print(
                            f"[{split}] {written:>7}/{n} ({rate:.0f} cells/s, "
                            f"read {_human_bytes(bytes_read)})",
                            file=sys.stderr,
                        )

    # Rewrite splits/<split>.jsonl with the new `idx` field.
    out_splits = dst / "splits"
    out_splits.mkdir(parents=True, exist_ok=True)
    out_split = out_splits / f"{split}.jsonl"
    with out_split.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    elapsed = time.time() - start
    size = h5_path.stat().st_size
    sha = _sha256_file(h5_path)
    print(
        f"[{split}] done: {n} cells in {elapsed:.1f}s "
        f"({n / max(elapsed, 0.001):.0f} cells/s); "
        f"{h5_path.name} = {_human_bytes(size)} sha256={sha}",
        file=sys.stderr,
    )
    return {
        "split": split,
        "n_cells": n,
        "h5_path": str(h5_path),
        "h5_size_bytes": size,
        "h5_sha256": sha,
        "seconds": round(elapsed, 2),
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--data-dir",
        required=True,
        type=Path,
        help="Path to v1/ root (contains cells/, splits/, manifest_v1.json).",
    )
    ap.add_argument(
        "--output-dir",
        required=True,
        type=Path,
        help="Path to v1-h5/ output (created if absent).",
    )
    ap.add_argument(
        "--workers",
        type=int,
        default=max(1, (os.cpu_count() or 4) - 1),
        help="Parallel PNG readers. Default: ncpu - 1.",
    )
    ap.add_argument(
        "--splits",
        nargs="+",
        default=list(SPLITS),
        choices=list(SPLITS),
        help="Subset of splits to convert (default: all three).",
    )
    args = ap.parse_args(argv)

    src: Path = args.data_dir.resolve()
    dst: Path = args.output_dir.resolve()
    if not src.is_dir():
        print(f"error: --data-dir not found: {src}", file=sys.stderr)
        return 2
    if not (src / "splits").is_dir():
        print(f"error: {src}/splits is missing", file=sys.stderr)
        return 2
    dst.mkdir(parents=True, exist_ok=True)

    # Copy manifest verbatim — kept in sync with v1/.
    manifest_src = src / "manifest_v1.json"
    if manifest_src.is_file():
        (dst / "manifest_v1.json").write_bytes(manifest_src.read_bytes())
        print(f"[manifest] copied {manifest_src} -> {dst / 'manifest_v1.json'}",
              file=sys.stderr)
    else:
        print(f"[manifest] WARN: {manifest_src} not found — skipping",
              file=sys.stderr)

    overall_start = time.time()
    summaries: List[Dict[str, Any]] = []
    for split in args.splits:
        summaries.append(convert_split(src, dst, split, workers=args.workers))

    total_bytes = sum(s["h5_size_bytes"] for s in summaries)
    total_cells = sum(s["n_cells"] for s in summaries)
    total_seconds = time.time() - overall_start
    print(
        f"\n=== Conversion done in {total_seconds:.1f}s "
        f"({total_cells:,} cells, total {_human_bytes(total_bytes)}) ===",
        file=sys.stderr,
    )
    for s in summaries:
        print(
            f"  {s['split']:>5}: {s['n_cells']:>7} cells  "
            f"{_human_bytes(s['h5_size_bytes']):>10}  "
            f"sha256={s['h5_sha256']}",
            file=sys.stderr,
        )
    # Machine-readable summary on stdout for downstream automation.
    print(json.dumps(
        {
            "data_dir": str(src),
            "output_dir": str(dst),
            "workers": args.workers,
            "splits": summaries,
            "total_cells": total_cells,
            "total_size_bytes": total_bytes,
            "total_seconds": round(total_seconds, 2),
        },
        ensure_ascii=False,
        indent=2,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
