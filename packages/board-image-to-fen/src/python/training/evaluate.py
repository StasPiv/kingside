"""Evaluate a trained board-recog checkpoint (KS-2361, ADR-040 Stage 2).

Reports:

* per-class accuracy (13 classes, empty + 12 pieces)
* per-style accuracy (each piece style in the manifest)
* end-to-end FEN match rate — % of 8×8 boards whose predicted cells reconstruct
  *exactly* the ground-truth piece placement

Writes ``evaluation_report.json`` to the directory of the checkpoint
(or to ``--output`` if provided).

Usage:

    python -m training.evaluate \\
        --data-dir /content/board-recog-v1 \\
        --checkpoint /content/runs/v1.0.0/best.pt \\
        --split val

The script supports both ``.pt`` PyTorch checkpoints (loads the model from
``training.model.build_model``) and ``.onnx`` artefacts (runs inference via
``onnxruntime`` — useful to verify that ONNX export did not regress accuracy).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np


# Stable ordering, matches manifest_v1.json["labels"].
LABELS: List[str] = [
    "empty",
    "wK", "wQ", "wR", "wB", "wN", "wP",
    "bK", "bQ", "bR", "bB", "bN", "bP",
]
LABEL_TO_IDX: Dict[str, int] = {n: i for i, n in enumerate(LABELS)}
IDX_TO_LABEL: Dict[int, str] = {i: n for i, n in enumerate(LABELS)}

# Top-3 styles per ADR-040 acceptance ("topic-3"): lichess_cburnett, our default,
# plus the chess.com-classic substitute (lichess_staunty in v1 — chess.com IP
# was excluded by chess-expert).
TOP3_STYLES = ("lichess_cburnett", "kingside_default", "lichess_staunty")


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data-dir", required=True, type=Path)
    p.add_argument(
        "--checkpoint", required=True, type=Path,
        help="Path to either a .pt PyTorch checkpoint or a .onnx artefact.",
    )
    p.add_argument("--split", default="val", choices=("train", "val", "test"))
    p.add_argument("--batch-size", type=int, default=512)
    p.add_argument("--num-workers", type=int, default=4)
    p.add_argument("--cell-size", type=int, default=64)
    p.add_argument(
        "--width-mult", type=float, default=None,
        help="Required for .pt checkpoints if their training_meta.json is missing.",
    )
    p.add_argument(
        "--output", type=Path, default=None,
        help="Path to evaluation_report.json. Default: <checkpoint-dir>/evaluation_report.json.",
    )
    p.add_argument(
        "--device", default=None,
        help="cpu / cuda — torch only. ONNX runtime picks providers automatically.",
    )
    return p.parse_args(argv)


# ---------------------------------------------------------------------------
# Prediction backends
# ---------------------------------------------------------------------------

class _BaseRunner:
    """Common API: returns int class predictions for a batch tensor."""

    def predict(self, images_chw_float32) -> np.ndarray:  # pragma: no cover
        raise NotImplementedError


class _TorchRunner(_BaseRunner):
    def __init__(self, checkpoint: Path, width_mult: Optional[float], device: str):
        import torch

        from .model import build_model

        ckpt = torch.load(checkpoint, map_location="cpu")
        train_args = ckpt.get("args", {}) or {}
        wm = width_mult or train_args.get("width_mult") or 1.0

        model = build_model(width_mult=float(wm), pretrained=False)
        model.load_state_dict(ckpt["model_state"])
        model.eval()
        model.to(device)
        self.model = model
        self.device = device
        self.torch = torch

    def predict(self, images) -> np.ndarray:
        torch = self.torch
        with torch.no_grad():
            x = images.to(self.device, non_blocking=True)
            logits = self.model(x)
            return logits.argmax(dim=1).cpu().numpy()


class _OnnxRunner(_BaseRunner):
    def __init__(self, checkpoint: Path):
        import onnxruntime as ort

        providers = ort.get_available_providers()
        # Prefer CUDA when present, else CPU.
        prefer = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider")
                  if p in providers]
        self.sess = ort.InferenceSession(str(checkpoint), providers=prefer)
        self.input_name = self.sess.get_inputs()[0].name
        self.output_name = self.sess.get_outputs()[0].name

    def predict(self, images) -> np.ndarray:
        # images may be a torch tensor — convert to numpy CHW float32.
        if hasattr(images, "cpu"):
            arr = images.cpu().numpy()
        else:
            arr = np.asarray(images)
        logits = self.sess.run([self.output_name], {self.input_name: arr.astype(np.float32)})[0]
        return logits.argmax(axis=1)


def _build_runner(checkpoint: Path, width_mult: Optional[float], device: str) -> _BaseRunner:
    suffix = checkpoint.suffix.lower()
    if suffix == ".onnx":
        return _OnnxRunner(checkpoint)
    if suffix in (".pt", ".pth"):
        return _TorchRunner(checkpoint, width_mult, device)
    raise ValueError(f"Unsupported checkpoint extension: {suffix}")


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def _grid_to_fen(grid: List[List[str]]) -> str:
    """Convert an 8x8 grid of labels (e.g. 'wR', 'empty') into FEN placement."""
    label_to_char = {
        "empty": None,
        "wK": "K", "wQ": "Q", "wR": "R", "wB": "B", "wN": "N", "wP": "P",
        "bK": "k", "bQ": "q", "bR": "r", "bB": "b", "bN": "n", "bP": "p",
    }
    rows: List[str] = []
    for row in grid:
        out: List[str] = []
        empties = 0
        for label in row:
            ch = label_to_char[label]
            if ch is None:
                empties += 1
                continue
            if empties:
                out.append(str(empties))
                empties = 0
            out.append(ch)
        if empties:
            out.append(str(empties))
        rows.append("".join(out))
    return "/".join(rows)


def evaluate(
    data_dir: Path,
    checkpoint: Path,
    split: str,
    batch_size: int,
    num_workers: int,
    cell_size: int,
    width_mult: Optional[float],
    device: str,
) -> Dict[str, Any]:
    # Late imports — keep CLI introspection cheap.
    import torch
    from torch.utils.data import DataLoader

    from .dataset import CellDataset, build_eval_transform, list_styles

    eval_tf = build_eval_transform(cell_size)
    ds = CellDataset(data_dir, split, transform=eval_tf)
    dl = DataLoader(
        ds,
        batch_size=batch_size,
        num_workers=num_workers,
        shuffle=False,
        drop_last=False,
        pin_memory=torch.cuda.is_available(),
    )
    runner = _build_runner(
        checkpoint,
        width_mult=width_mult,
        device=device or ("cuda" if torch.cuda.is_available() else "cpu"),
    )

    # Per-class counters: (tp, total) per label index.
    per_class_tp: Dict[int, int] = defaultdict(int)
    per_class_total: Dict[int, int] = defaultdict(int)

    # Per-style counters: (tp, total) per style.
    per_style_tp: Dict[str, int] = defaultdict(int)
    per_style_total: Dict[str, int] = defaultdict(int)

    # Reassemble each board: key = (style, fen_idx) → 64-length list of
    # (square_idx, gt_label_idx, pred_label_idx).
    board_buf: Dict[Tuple[str, int], List[Tuple[int, int, int]]] = defaultdict(list)

    total = 0
    correct = 0
    for batch in dl:
        preds = runner.predict(batch["image"])
        labels = batch["label"].numpy()
        styles = batch["style"]               # list[str]
        fen_indices = batch["fen_idx"].numpy()
        squares = batch["square"].numpy()

        total += len(labels)
        correct += int((preds == labels).sum())

        for i in range(len(labels)):
            gt = int(labels[i])
            pr = int(preds[i])
            st = styles[i]
            per_class_total[gt] += 1
            per_style_total[st] += 1
            if gt == pr:
                per_class_tp[gt] += 1
                per_style_tp[st] += 1
            board_buf[(st, int(fen_indices[i]))].append(
                (int(squares[i]), gt, pr)
            )

    # End-to-end FEN match — only boards with all 64 cells in the split count.
    fen_total = 0
    fen_match = 0
    fen_total_per_style: Dict[str, int] = defaultdict(int)
    fen_match_per_style: Dict[str, int] = defaultdict(int)
    for (style, _), cells in board_buf.items():
        if len(cells) != 64:
            # Boards split across train/val/test (the deterministic_split key
            # is per-fen so this should not happen, but guard anyway).
            continue
        fen_total += 1
        fen_total_per_style[style] += 1

        cells_sorted = sorted(cells, key=lambda t: t[0])
        gt_grid = [[IDX_TO_LABEL[cells_sorted[r * 8 + f][1]] for f in range(8)]
                   for r in range(8)]
        pr_grid = [[IDX_TO_LABEL[cells_sorted[r * 8 + f][2]] for f in range(8)]
                   for r in range(8)]
        if _grid_to_fen(gt_grid) == _grid_to_fen(pr_grid):
            fen_match += 1
            fen_match_per_style[style] += 1

    per_class = {
        IDX_TO_LABEL[idx]: {
            "total": per_class_total[idx],
            "correct": per_class_tp[idx],
            "accuracy": (per_class_tp[idx] / per_class_total[idx])
                        if per_class_total[idx] else None,
        }
        for idx in sorted(per_class_total)
    }
    per_style = {
        style: {
            "total": per_style_total[style],
            "correct": per_style_tp[style],
            "accuracy": (per_style_tp[style] / per_style_total[style])
                        if per_style_total[style] else None,
        }
        for style in sorted(per_style_total)
    }
    per_style_fen = {
        style: {
            "boards": fen_total_per_style[style],
            "match": fen_match_per_style[style],
            "match_rate": (fen_match_per_style[style] / fen_total_per_style[style])
                          if fen_total_per_style[style] else None,
        }
        for style in sorted(fen_total_per_style)
    }

    known_styles = list_styles(data_dir)
    top3_present = [s for s in TOP3_STYLES if s in per_style]
    other_styles = [s for s in known_styles if s not in TOP3_STYLES and s in per_style]

    def _agg(styles, src):
        tot = sum(src[s]["total"] for s in styles)
        cor = sum(src[s]["correct"] for s in styles)
        return {
            "styles": styles,
            "total": tot,
            "correct": cor,
            "accuracy": (cor / tot) if tot else None,
        }

    return {
        "split": split,
        "checkpoint": str(checkpoint),
        "data_dir": str(data_dir),
        "overall": {
            "total": total,
            "correct": correct,
            "accuracy": (correct / total) if total else None,
        },
        "fen_match": {
            "boards": fen_total,
            "match": fen_match,
            "match_rate": (fen_match / fen_total) if fen_total else None,
        },
        "per_class_accuracy": per_class,
        "per_style_accuracy": per_style,
        "per_style_fen_match": per_style_fen,
        "acceptance_summary": {
            "top3_styles": _agg(top3_present, per_style),
            "other_styles": _agg(other_styles, per_style),
            "fen_match_rate": (fen_match / fen_total) if fen_total else None,
        },
    }


def main(argv=None) -> int:
    args = parse_args(argv)

    report = evaluate(
        data_dir=args.data_dir,
        checkpoint=args.checkpoint,
        split=args.split,
        batch_size=args.batch_size,
        num_workers=args.num_workers,
        cell_size=args.cell_size,
        width_mult=args.width_mult,
        device=args.device,
    )

    out_path = args.output or (args.checkpoint.parent / "evaluation_report.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"[eval] split={args.split} overall_acc="
          f"{report['overall']['accuracy']:.4f} "
          f"fen_match={report['fen_match']['match_rate']:.4f}",
          file=sys.stderr)
    print(f"[eval] wrote {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
