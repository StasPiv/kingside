"""PyTorch Dataset over the board-recog v1 dataset (KS-2360).

Each split file (`data/v1/splits/{train,val,test}.jsonl`) lists one cell per
line:

    {"path": "cells/lichess_cburnett/0000/000000_00.png",
     "label": "wR", "label_idx": 3,
     "style": "lichess_cburnett", "palette": "lichess_brown",
     "fen_idx": 0, "square": 0, "split": "train"}

`path` is relative to `--data-dir` (the directory that contains `cells/`,
`splits/`, `manifest_v1.json`).
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np
from PIL import Image
from torch.utils.data import Dataset


# Label set is fixed by manifest_v1.json. Re-declared here so that the training
# script does not crash if the manifest is missing (CI / dry runs).
LABELS: List[str] = [
    "empty",
    "wK", "wQ", "wR", "wB", "wN", "wP",
    "bK", "bQ", "bR", "bB", "bN", "bP",
]
LABEL_TO_IDX: Dict[str, int] = {name: idx for idx, name in enumerate(LABELS)}
NUM_CLASSES: int = len(LABELS)


def _load_split(split_path: Path) -> List[Dict[str, Any]]:
    """Read a JSONL split file into a list of dicts."""
    rows: List[Dict[str, Any]] = []
    with split_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


class CellDataset(Dataset):
    """Per-cell classification dataset.

    Parameters
    ----------
    data_dir
        Root that contains `cells/` and `splits/` (the manifest's working dir).
    split
        One of ``"train"``, ``"val"``, ``"test"``.
    transform
        Albumentations transform applied to a HxWx3 uint8 ndarray. Must
        return a dict with key ``"image"`` (Tensor CxHxW float32).
    style_filter
        Optional iterable of style names; rows with other styles are dropped.
        Useful for slicing per-style evaluation.
    """

    def __init__(
        self,
        data_dir: str | Path,
        split: str,
        transform: Optional[Callable[..., Dict[str, Any]]] = None,
        style_filter: Optional[List[str]] = None,
    ) -> None:
        self.data_dir = Path(data_dir).resolve()
        self.split = split
        self.transform = transform

        split_path = self.data_dir / "splits" / f"{split}.jsonl"
        if not split_path.is_file():
            raise FileNotFoundError(
                f"Split file not found: {split_path}. "
                f"Did you download data/v1 from S3?"
            )
        rows = _load_split(split_path)
        if style_filter is not None:
            allowed = set(style_filter)
            rows = [r for r in rows if r["style"] in allowed]
        if not rows:
            raise RuntimeError(
                f"Empty split after filter: {split_path} style_filter={style_filter!r}"
            )
        self.rows = rows

        # KS-3080 / runbook §9.6. Choose storage backend:
        #   * h5  — single packed HDF5 with PNG bytes (production / cloud train)
        #   * png — individual PNGs (mini-dataset / cpu-dry-run / local debug)
        # h5py is NOT fork-safe — `self._h5` is opened lazily inside
        # `__getitem__`, after `DataLoader` has forked the worker process.
        self.h5_path: Path = self.data_dir / f"cells_{split}.h5"
        if self.h5_path.is_file():
            self._mode: str = "h5"
        else:
            self._mode = "png"
            if not (self.data_dir / "cells").is_dir():
                raise FileNotFoundError(
                    f"Neither {self.h5_path} nor {self.data_dir / 'cells'} "
                    f"found. Did you download v1-h5/ (or v1/) from S3?"
                )
        self._h5: Any = None

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> Dict[str, Any]:
        row = self.rows[index]

        # KS-3080 / runbook §9.6.3. Branch by storage backend.
        if self._mode == "h5":
            if self._h5 is None:
                # Lazy open per DataLoader worker (h5py NOT fork-safe).
                import h5py
                self._h5 = h5py.File(self.h5_path, "r")
            data = bytes(self._h5["cells"][int(row["idx"])])
            with Image.open(io.BytesIO(data)) as im:
                im = im.convert("RGB")
                arr = np.asarray(im, dtype=np.uint8)
        else:
            img_path = self.data_dir / row["path"]
            # Cells are saved as RGBA PNG by dataset_gen.py; convert to RGB.
            with Image.open(img_path) as im:
                im = im.convert("RGB")
                arr = np.asarray(im, dtype=np.uint8)

        label_idx = int(row["label_idx"])

        if self.transform is not None:
            out = self.transform(image=arr)
            image_tensor = out["image"]
        else:
            # Fallback: HWC uint8 -> CHW float32 in [0, 1].
            import torch
            image_tensor = (
                torch.from_numpy(arr).permute(2, 0, 1).float() / 255.0
            )

        return {
            "image": image_tensor,
            "label": label_idx,
            "style": row["style"],
            "fen_idx": int(row["fen_idx"]),
            "square": int(row["square"]),
            "palette": row.get("palette", ""),
        }


# ---------------------------------------------------------------------------
# Default Albumentations transforms.
# ---------------------------------------------------------------------------

def build_train_transform(cell_size: int = 64):
    """Augmentations used during training.

    Kept light — the dataset is already synthetically diverse (10+ palettes,
    7 piece styles). Aggressive augments hurt convergence on tiny 64x64 cells.
    """
    import albumentations as A
    import cv2  # used below for explicit BORDER_CONSTANT
    from albumentations.pytorch import ToTensorV2

    return A.Compose([
        A.LongestMaxSize(max_size=cell_size),
        A.PadIfNeeded(
            min_height=cell_size,
            min_width=cell_size,
            border_mode=cv2.BORDER_CONSTANT,
            value=0,
        ),
        # Geometry — slight jitter to model crop noise from board_detect.py.
        A.Affine(
            translate_percent={"x": (-0.06, 0.06), "y": (-0.06, 0.06)},
            scale=(0.92, 1.08),
            rotate=(-4, 4),
            p=0.7,
        ),
        # Photometric noise — model must survive JPEG board screenshots.
        A.RandomBrightnessContrast(
            brightness_limit=0.15, contrast_limit=0.15, p=0.5,
        ),
        A.HueSaturationValue(
            hue_shift_limit=4, sat_shift_limit=10, val_shift_limit=10, p=0.3,
        ),
        A.GaussNoise(var_limit=(5.0, 20.0), p=0.2),
        A.ImageCompression(quality_lower=70, quality_upper=100, p=0.3),
        A.Normalize(
            mean=(0.485, 0.456, 0.406),
            std=(0.229, 0.224, 0.225),
        ),
        ToTensorV2(),
    ])


def build_eval_transform(cell_size: int = 64):
    """No augmentation, just resize + normalize."""
    import albumentations as A
    import cv2  # used below for explicit BORDER_CONSTANT
    from albumentations.pytorch import ToTensorV2

    return A.Compose([
        A.LongestMaxSize(max_size=cell_size),
        A.PadIfNeeded(
            min_height=cell_size,
            min_width=cell_size,
            border_mode=cv2.BORDER_CONSTANT,
            value=0,
        ),
        A.Normalize(
            mean=(0.485, 0.456, 0.406),
            std=(0.229, 0.224, 0.225),
        ),
        ToTensorV2(),
    ])


def list_styles(data_dir: str | Path) -> List[str]:
    """Read style names from manifest_v1.json (if present), else from train split."""
    data_dir = Path(data_dir).resolve()
    manifest_candidates = [
        data_dir / "manifest_v1.json",
        data_dir.parent / "manifest_v1.json",
    ]
    for cand in manifest_candidates:
        if cand.is_file():
            meta = json.loads(cand.read_text())
            return [s["name"] for s in meta.get("styles", [])]
    # Fallback: scan train split.
    rows = _load_split(data_dir / "splits" / "train.jsonl")
    return sorted({r["style"] for r in rows})
