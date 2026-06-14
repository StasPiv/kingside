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
# v2 Dataset (KS-3091, ADR-040-v2). Все метки + стили + индексы лежат внутри
# `cells_<split>.h5` рядом с PNG-байтами — нет отдельного jsonl, не нужно
# хранить миллион rows в RAM. Структура h5:
#   - cells   : vlen uint8 (PNG bytes)
#   - labels  : uint8 (LABEL_TO_IDX)
#   - styles  : ascii string (для per-style оценки на val)
#   - (val)   : fen_idx uint16, square uint8, val_fens (attribute)
# ---------------------------------------------------------------------------


class CellDatasetV2(Dataset):
    """v2 Dataset, читает напрямую из `cells_<split>.h5` без JSONL-индекса.

    Parameters
    ----------
    data_dir
        Папка, содержащая `cells_<split>.h5`. Обычно
        `packages/board-image-to-fen/data/v2`.
    split
        ``"train"`` или ``"val"``. (test'а в v2 нет — held-out val
        совмещает обе роли по ADR-040-v2.)
    transform
        Albumentations-трансформ (HxWx3 uint8 → dict с key ``"image"``).
    style_filter
        Опционально: оставить только клетки указанных стилей. Полезно
        для per-style оценки на val.
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
        self.h5_path = self.data_dir / f"cells_{split}.h5"
        if not self.h5_path.is_file():
            raise FileNotFoundError(
                f"v2 cells file not found: {self.h5_path}. "
                f"Run dataset_gen.py --style-set both."
            )

        # h5py НЕ fork-safe. Здесь открываем один раз для построения индекса
        # фильтрации, потом закрываем, и каждый worker откроет файл лениво
        # в __getitem__.
        import h5py
        with h5py.File(self.h5_path, "r") as fh:
            n_total = int(fh["cells"].shape[0])
            if style_filter is not None:
                allowed = set(style_filter)
                styles = fh["styles"][:]
                # styles — это array of bytes. Декодируем.
                mask = np.array(
                    [s.decode("ascii") in allowed for s in styles], dtype=bool,
                )
                self.indices = np.flatnonzero(mask)
                if self.indices.size == 0:
                    raise RuntimeError(
                        f"Empty after style_filter={sorted(allowed)} "
                        f"in {self.h5_path}"
                    )
            else:
                self.indices = np.arange(n_total, dtype=np.int64)
        self._h5: Any = None

    def __len__(self) -> int:
        return int(self.indices.size)

    def __getitem__(self, index: int) -> Dict[str, Any]:
        if self._h5 is None:
            import h5py
            self._h5 = h5py.File(self.h5_path, "r")

        h5_idx = int(self.indices[index])
        png_bytes = bytes(self._h5["cells"][h5_idx])
        with Image.open(io.BytesIO(png_bytes)) as im:
            im = im.convert("RGB")
            arr = np.asarray(im, dtype=np.uint8)

        label_idx = int(self._h5["labels"][h5_idx])
        style = self._h5["styles"][h5_idx]
        if isinstance(style, bytes):
            style = style.decode("ascii")

        if self.transform is not None:
            image_tensor = self.transform(image=arr)["image"]
        else:
            import torch
            image_tensor = (
                torch.from_numpy(arr).permute(2, 0, 1).float() / 255.0
            )

        out = {
            "image": image_tensor,
            "label": label_idx,
            "style": style,
            "h5_idx": h5_idx,
        }
        # Val содержит дополнительные поля для end-to-end FEN-match метрики.
        if "fen_idx" in self._h5:
            out["fen_idx"] = int(self._h5["fen_idx"][h5_idx])
            out["square"] = int(self._h5["square"][h5_idx])
        return out


# ---------------------------------------------------------------------------
# Default Albumentations transforms.
# ---------------------------------------------------------------------------

# KS-3091 / ADR-040-v2 §1.1. Albumentations-pipeline вынесен в `transforms.py`,
# чтобы можно было визуально аудитировать аугментацию (preview_augmented_v2.py)
# без затягивания torch. Тренировка (этап C/D) импортирует те же функции —
# контракт остаётся прежним.
from .transforms import build_train_transform, build_eval_transform  # noqa: F401


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
