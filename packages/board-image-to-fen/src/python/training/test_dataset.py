"""Unit-tests for CellDataset (KS-3080 §9.6 — HDF5 backend + PNG fallback).

Standalone unittest module so that the tests can be invoked without pytest:

    python -m unittest training.test_dataset

The HDF5 path requires `h5py` — when it's not installed, the corresponding
test is skipped (the PNG fallback path is exercised unconditionally).
"""

from __future__ import annotations

import importlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List


_TORCH_AVAILABLE: bool
try:
    importlib.import_module("torch")
    _TORCH_AVAILABLE = True
except ImportError:
    _TORCH_AVAILABLE = False

_H5PY_AVAILABLE: bool
try:
    importlib.import_module("h5py")
    _H5PY_AVAILABLE = True
except ImportError:
    _H5PY_AVAILABLE = False


def _identity_transform(*, image):
    """Bypass Albumentations / ToTensorV2 — keep tests free of torch/alb deps
    other than what CellDataset itself imports.

    Returns the raw HxWx3 uint8 array under the same key the production
    transform uses, so `CellDataset.__getitem__` can wrap it transparently.
    """
    return {"image": image}


def _make_png_bytes(rgb_pixel: int, size: int = 16) -> bytes:
    """Generate a deterministic PNG of `size`×`size` filled with one colour."""
    from PIL import Image  # local import keeps top-of-file lean
    import numpy as np

    arr = np.full((size, size, 3), rgb_pixel, dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr, mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _write_split_jsonl(path: Path, rows: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


class CellDatasetPngFallbackTest(unittest.TestCase):
    """`__getitem__` reads individual PNG files when no HDF5 sidecar exists."""

    @unittest.skipUnless(_TORCH_AVAILABLE, "torch not installed in this env")
    def test_png_mode_returns_decoded_pixels(self) -> None:
        from training.dataset import CellDataset

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cells_dir = root / "cells" / "style_a" / "0000"
            cells_dir.mkdir(parents=True)
            rows: List[Dict[str, Any]] = []
            colours = [10, 128, 220]
            for i, pixel in enumerate(colours):
                rel = f"cells/style_a/0000/000000_{i:02d}.png"
                (root / rel).write_bytes(_make_png_bytes(pixel))
                rows.append({
                    "path": rel, "label": "empty", "label_idx": 0,
                    "style": "style_a", "palette": "p",
                    "fen_idx": 0, "square": i, "split": "train",
                })
            _write_split_jsonl(root / "splits" / "train.jsonl", rows)

            ds = CellDataset(root, "train", transform=_identity_transform)
            self.assertEqual(ds._mode, "png")
            self.assertEqual(len(ds), 3)

            for i, expected_pixel in enumerate(colours):
                item = ds[i]
                image = item["image"]
                self.assertEqual(image.shape, (16, 16, 3))
                # PIL roundtrip is lossless for solid-colour RGB PNGs.
                self.assertEqual(int(image[0, 0, 0]), expected_pixel)
                self.assertEqual(item["label"], 0)
                self.assertEqual(item["square"], i)


class CellDatasetH5BackendTest(unittest.TestCase):
    """`__getitem__` reads PNG bytes from cells_<split>.h5 by `idx`."""

    @unittest.skipUnless(
        _TORCH_AVAILABLE and _H5PY_AVAILABLE,
        "torch / h5py not installed in this env",
    )
    def test_h5_mode_returns_decoded_pixels(self) -> None:
        import h5py
        import numpy as np
        from training.dataset import CellDataset

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Three deterministic PNGs of different solid colours.
            colours = [40, 120, 200]
            payloads = [_make_png_bytes(c) for c in colours]

            # cells_train.h5 with a vlen(uint8) dataset 'cells'.
            h5_path = root / "cells_train.h5"
            vlen_u8 = h5py.vlen_dtype(np.dtype("uint8"))
            with h5py.File(h5_path, "w") as f:
                ds = f.create_dataset(
                    "cells", shape=(3,), dtype=vlen_u8, chunks=True,
                )
                for i, blob in enumerate(payloads):
                    ds[i] = np.frombuffer(blob, dtype=np.uint8)

            # JSONL with explicit 'idx' field — order in h5 != order in JSONL,
            # so the test verifies the idx lookup, not positional fallback.
            rows = [
                {"path": "cells/x/x/0.png", "label": "empty", "label_idx": 0,
                 "style": "style_a", "palette": "p", "fen_idx": 0, "square": 0,
                 "split": "train", "idx": 2},
                {"path": "cells/x/x/1.png", "label": "wP", "label_idx": 6,
                 "style": "style_a", "palette": "p", "fen_idx": 0, "square": 1,
                 "split": "train", "idx": 0},
                {"path": "cells/x/x/2.png", "label": "bK", "label_idx": 7,
                 "style": "style_b", "palette": "p", "fen_idx": 0, "square": 2,
                 "split": "train", "idx": 1},
            ]
            _write_split_jsonl(root / "splits" / "train.jsonl", rows)

            ds = CellDataset(root, "train", transform=_identity_transform)
            self.assertEqual(ds._mode, "h5")
            self.assertEqual(len(ds), 3)
            self.assertIsNone(ds._h5)   # not opened until first __getitem__

            # Row 0 → idx 2 → colours[2] (200)
            item0 = ds[0]
            self.assertEqual(item0["image"].shape, (16, 16, 3))
            self.assertEqual(int(item0["image"][0, 0, 0]), colours[2])
            self.assertEqual(item0["label"], 0)
            # h5 handle now lazy-opened.
            self.assertIsNotNone(ds._h5)

            # Row 1 → idx 0 → colours[0] (40)
            item1 = ds[1]
            self.assertEqual(int(item1["image"][0, 0, 0]), colours[0])
            self.assertEqual(item1["label"], 6)
            self.assertEqual(item1["style"], "style_a")

            # Row 2 → idx 1 → colours[1] (120)
            item2 = ds[2]
            self.assertEqual(int(item2["image"][0, 0, 0]), colours[1])
            self.assertEqual(item2["label"], 7)
            self.assertEqual(item2["style"], "style_b")

    @unittest.skipUnless(
        _TORCH_AVAILABLE and _H5PY_AVAILABLE,
        "torch / h5py not installed in this env",
    )
    def test_h5_takes_priority_over_png(self) -> None:
        """When both cells_<split>.h5 and cells/ exist, h5 wins."""
        import h5py
        import numpy as np
        from training.dataset import CellDataset

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            # PNG path with a red pixel.
            (root / "cells" / "x" / "x").mkdir(parents=True)
            red = _make_png_bytes(255)
            (root / "cells" / "x" / "x" / "0.png").write_bytes(red)

            # h5 with a green-ish pixel — should be picked.
            h5_path = root / "cells_train.h5"
            vlen_u8 = h5py.vlen_dtype(np.dtype("uint8"))
            green = _make_png_bytes(64)
            with h5py.File(h5_path, "w") as f:
                ds = f.create_dataset(
                    "cells", shape=(1,), dtype=vlen_u8, chunks=True,
                )
                ds[0] = np.frombuffer(green, dtype=np.uint8)

            _write_split_jsonl(
                root / "splits" / "train.jsonl",
                [{"path": "cells/x/x/0.png", "label": "empty", "label_idx": 0,
                  "style": "style_a", "palette": "p", "fen_idx": 0, "square": 0,
                  "split": "train", "idx": 0}],
            )

            ds = CellDataset(root, "train", transform=_identity_transform)
            self.assertEqual(ds._mode, "h5")
            item = ds[0]
            self.assertEqual(int(item["image"][0, 0, 0]), 64)


class CellDatasetErrorTest(unittest.TestCase):
    """When neither HDF5 nor cells/ exist, init must fail loudly."""

    @unittest.skipUnless(_TORCH_AVAILABLE, "torch not installed in this env")
    def test_missing_both_raises(self) -> None:
        from training.dataset import CellDataset

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_split_jsonl(
                root / "splits" / "train.jsonl",
                [{"path": "cells/x/x/0.png", "label": "empty", "label_idx": 0,
                  "style": "style_a", "palette": "p", "fen_idx": 0, "square": 0,
                  "split": "train"}],
            )
            with self.assertRaises(FileNotFoundError):
                CellDataset(root, "train", transform=_identity_transform)


if __name__ == "__main__":
    unittest.main()
