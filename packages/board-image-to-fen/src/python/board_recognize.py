#!/usr/bin/env python3
"""KS-2362 / ADR-040 Stage 3. Universal end-to-end board recognition.

Pipeline:

    image (PNG/JPG)
        ↓
    [Stage 1: board_detect]            ← KS-2359 (board_detect.py)
        ↓
    warped 512×512 (no border)
        ↓
    [Stage 2: cell classification]      ← KS-2361 (ONNX MobileNetV3-Small)
        ↓
    8×8 grid of (label, confidence)
        ↓
    [Stage 3: orientation + FEN + sanity]
        ↓
    {fen, fen_board, orientation, cells, low_confidence_cells, sanity}

This script is the *universal* recognizer — it works on any board screenshot
regardless of the piece-set style (lichess, chess.com, our own, ...). It is
*not* a drop-in replacement for the existing Maizelis/Dvoretsky recognizers
(``recognizer.py``, ``pdf_recognizer.py``): those are font-specific template
matchers that are far more accurate on their own domains but blind to anything
else. ``recognizeUniversal()`` (the TS wrapper) and the ``--profile=auto``
CLI mode chain both paths together — see ``src/index.ts`` and ``src/cli.ts``.

## CLI

    python3 board_recognize.py <image> --model <model.onnx>
                              [--orientation auto|white|black]
                              [--low-confidence-threshold 0.85]
                              [--json]

Without ``--json`` the script prints a single FEN line (board part only) to
stdout, diagnostics to stderr. With ``--json`` it prints a structured document
matching the ``RecognizeResult`` TS type in ``src/index.ts``.

## Python API

    from board_recognize import recognize
    result = recognize('screenshot.png', model_path='model.onnx')
    print(result['fen'])
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from board_detect import detect_board


# ─── Constants ───────────────────────────────────────────────────────

# 13 classes; index order matches training/dataset.py LABELS and
# packages/board-image-to-fen/data/manifest_v1.json.
LABELS: List[str] = [
    "empty",
    "wK", "wQ", "wR", "wB", "wN", "wP",
    "bK", "bQ", "bR", "bB", "bN", "bP",
]
LABEL_TO_FEN: Dict[str, Optional[str]] = {
    "empty": None,
    "wK": "K", "wQ": "Q", "wR": "R", "wB": "B", "wN": "N", "wP": "P",
    "bK": "k", "bQ": "q", "bR": "r", "bB": "b", "bN": "n", "bP": "p",
}

# Warped board is 512×512 → 64-px cells (matches training input).
CELL_SIZE = 64
GRID_SIZE = 8

# ImageNet normalization — must match training/dataset.py.build_eval_transform.
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Default low-confidence threshold (per-cell). Aligned with empirical CNN
# behaviour on the v1 dataset: well-classified cells score ≥ 0.95;
# anything ≤ 0.85 is usually genuinely ambiguous.
DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.85

# Default ONNX model location lookup order (used when --model is omitted).
DEFAULT_MODEL_ENV = "BOARD_RECOG_MODEL_PATH"


# ─── Public API ──────────────────────────────────────────────────────


def recognize(
    image_path: str,
    model_path: Optional[str] = None,
    orientation: str = "auto",
    low_confidence_threshold: float = DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    unet_model_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Run the full pipeline on ``image_path`` and return a result dict.

    Parameters
    ----------
    image_path
        Path to a PNG/JPG/BMP screenshot or photo.
    model_path
        Path to the ONNX classifier from KS-2361. If ``None``, falls back to
        the ``BOARD_RECOG_MODEL_PATH`` env var. Raises ``FileNotFoundError``
        if the resolved path does not exist.
    orientation
        ``"auto"`` (default), ``"white"`` (white at the bottom), or ``"black"``
        (black at the bottom). ``"auto"`` infers from king positions, falling
        back to majority piece colour in the top half.
    low_confidence_threshold
        Cells whose top-1 softmax probability is below this go into
        ``low_confidence_cells``. Default ``0.85``.
    unet_model_path
        Optional UNet model for the board-detect fallback (see board_detect.py).

    Returns
    -------
    A dict with keys:

        success: bool
        stage:   None | 'detect' | 'classify'        (stage that failed)
        fen, fen_board, orientation
        detect:  {method, confidence, corners, image_size}
        cells:   list of 64 cell dicts (row, col, square, predicted, confidence, top3)
        low_confidence_cells: subset of cells below the threshold
        sanity:  {valid: bool, issues: [str, ...]}
        error:   str (only when success is False)
    """
    if orientation not in ("auto", "white", "black"):
        raise ValueError(f"orientation must be auto|white|black, got {orientation!r}")

    resolved_model = _resolve_model_path(model_path)

    # Stage 1: board detection.
    detect = detect_board(image_path, unet_model_path=unet_model_path)
    if not detect.get("success"):
        return {
            "success": False,
            "stage": "detect",
            "error": detect.get("error") or "board detection failed",
            "detect": {
                "method": detect.get("method"),
                "confidence": detect.get("confidence", 0.0),
                "corners": detect.get("corners"),
                "image_size": detect.get("image_size"),
            },
        }

    warped = detect.pop("warped", None)
    if warped is None:
        return {
            "success": False,
            "stage": "detect",
            "error": "warped image missing",
            "detect": detect,
        }

    # Stage 2: classify each cell.
    cells_array = _split_into_cells(warped)               # (64, CELL, CELL, 3) BGR
    cells_normalized = _preprocess_cells(cells_array)     # (64, 3, CELL, CELL)
    logits = _run_onnx(resolved_model, cells_normalized)  # (64, 13)
    probs = _softmax(logits, axis=1)                      # (64, 13)
    pred_idx = probs.argmax(axis=1)                       # (64,)
    pred_conf = probs[np.arange(64), pred_idx]            # (64,)

    raw_grid = [[None] * GRID_SIZE for _ in range(GRID_SIZE)]
    raw_conf = [[0.0] * GRID_SIZE for _ in range(GRID_SIZE)]
    raw_top3: List[List[List[Tuple[str, float]]]] = [
        [[] for _ in range(GRID_SIZE)] for _ in range(GRID_SIZE)
    ]
    for sq in range(64):
        r, c = divmod(sq, GRID_SIZE)
        raw_grid[r][c] = LABELS[int(pred_idx[sq])]
        raw_conf[r][c] = float(pred_conf[sq])
        top_indices = np.argsort(-probs[sq])[:3]
        raw_top3[r][c] = [
            (LABELS[int(i)], float(probs[sq, int(i)])) for i in top_indices
        ]

    # Stage 3a: orientation.
    effective_orientation = (
        _infer_orientation(raw_grid) if orientation == "auto" else orientation
    )
    if effective_orientation == "black":
        oriented_grid = _flip_grid(raw_grid)
        oriented_conf = _flip_grid(raw_conf)
        oriented_top3 = _flip_grid(raw_top3)
    else:
        oriented_grid = raw_grid
        oriented_conf = raw_conf
        oriented_top3 = raw_top3

    # Stage 3b: FEN + sanity.
    fen_board = _grid_to_fen(oriented_grid)
    fen = f"{fen_board} w - - 0 1"
    sanity = _sanity_check(oriented_grid)

    cells_payload: List[Dict[str, Any]] = []
    low_conf_payload: List[Dict[str, Any]] = []
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            label = oriented_grid[r][c]
            cell = {
                "row": r,
                "col": c,
                "square": _algebraic(r, c, effective_orientation),
                "bg": "l" if (r + c) % 2 == 0 else "d",
                "predicted": label,
                "piece": LABEL_TO_FEN[label] or ".",
                "confidence": oriented_conf[r][c],
                "top3": [
                    {"label": lbl, "prob": prob} for lbl, prob in oriented_top3[r][c]
                ],
            }
            cells_payload.append(cell)
            if oriented_conf[r][c] < low_confidence_threshold:
                low_conf_payload.append(cell)

    image_size = detect.get("image_size") or [warped.shape[1], warped.shape[0]]
    corners = detect.get("corners") or []
    bbox = _bbox_from_corners(corners) if corners else [
        0, 0, int(image_size[0]), int(image_size[1])
    ]

    return {
        "success": True,
        "stage": None,
        "fen": fen,
        "fen_board": fen_board,
        "orientation": effective_orientation,
        "bbox": bbox,
        "detect": {
            "method": detect.get("method"),
            "confidence": float(detect.get("confidence", 0.0)),
            "corners": corners,
            "image_size": image_size,
        },
        "cells": cells_payload,
        "low_confidence_cells": low_conf_payload,
        "sanity": sanity,
        "model_path": resolved_model,
    }


# ─── Internals ───────────────────────────────────────────────────────


def _resolve_model_path(model_path: Optional[str]) -> str:
    """Return an existing model path or raise FileNotFoundError."""
    path = model_path or os.environ.get(DEFAULT_MODEL_ENV)
    if not path:
        raise FileNotFoundError(
            "ONNX model not provided. Pass --model <path> or set "
            f"${DEFAULT_MODEL_ENV}."
        )
    if not os.path.isfile(path):
        raise FileNotFoundError(f"ONNX model not found: {path}")
    return path


def _split_into_cells(warped_bgr: np.ndarray) -> np.ndarray:
    """Reshape 512×512 BGR image into (64, CELL, CELL, 3) row-major.

    Row 0 = top of the image (rank 8 for orientation=white).
    """
    if warped_bgr.shape[:2] != (CELL_SIZE * GRID_SIZE, CELL_SIZE * GRID_SIZE):
        raise ValueError(
            f"expected warped shape ({CELL_SIZE * GRID_SIZE},"
            f"{CELL_SIZE * GRID_SIZE},*), got {warped_bgr.shape}"
        )
    cells = np.empty((64, CELL_SIZE, CELL_SIZE, 3), dtype=warped_bgr.dtype)
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            y0, x0 = r * CELL_SIZE, c * CELL_SIZE
            cells[r * GRID_SIZE + c] = warped_bgr[y0:y0 + CELL_SIZE, x0:x0 + CELL_SIZE]
    return cells


def _preprocess_cells(cells_bgr: np.ndarray) -> np.ndarray:
    """BGR uint8 (N,H,W,3) → RGB float32 (N,3,H,W) normalized with ImageNet stats.

    Matches training/dataset.py.build_eval_transform: no augmentation, just
    LongestMaxSize+Pad (no-op when input is already 64×64), Normalize, ToTensor.
    """
    # BGR → RGB.
    rgb = cells_bgr[..., ::-1].astype(np.float32) / 255.0
    rgb = (rgb - IMAGENET_MEAN) / IMAGENET_STD
    # HWC → CHW per batch element.
    chw = np.transpose(rgb, (0, 3, 1, 2)).astype(np.float32, copy=False)
    return chw


def _run_onnx(model_path: str, batch_chw: np.ndarray) -> np.ndarray:
    """Run a single batched inference call. Returns (N, 13) logits."""
    # Lazy import — onnxruntime ships a sizeable shared library; only load it
    # when we actually need to classify (not at module import for `--help`).
    import onnxruntime as ort

    providers = ort.get_available_providers()
    # Prefer CUDA when present, else CPU. We don't pass execution-mode hints
    # because the ONNX graph is fully constant-folded at export time.
    prefer = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider")
              if p in providers]
    sess = ort.InferenceSession(model_path, providers=prefer)
    input_name = sess.get_inputs()[0].name
    output_name = sess.get_outputs()[0].name
    logits = sess.run([output_name], {input_name: batch_chw})[0]
    return np.asarray(logits, dtype=np.float32)


def _softmax(x: np.ndarray, axis: int = -1) -> np.ndarray:
    """Numerically stable softmax."""
    x = x - x.max(axis=axis, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=axis, keepdims=True)


def _flip_grid(grid):
    """180° rotation: row r col c ↔ row 7-r col 7-c.

    Used when ``orientation == 'black'`` — the warped image still has rank 1
    at the bottom, but the player's perspective swaps both axes.
    """
    return [[grid[GRID_SIZE - 1 - r][GRID_SIZE - 1 - c]
             for c in range(GRID_SIZE)]
            for r in range(GRID_SIZE)]


def _grid_to_fen(grid: List[List[str]]) -> str:
    """Convert an 8×8 grid of labels into FEN board notation."""
    rows: List[str] = []
    for row in grid:
        out: List[str] = []
        empties = 0
        for label in row:
            ch = LABEL_TO_FEN[label]
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


def _algebraic(row: int, col: int, orientation: str) -> str:
    """Algebraic square (e.g. 'e4') for a (row, col) in the *oriented* grid.

    Row 0 / col 0 of the oriented grid is always the top-left from the
    perspective of the player whose side is at the bottom. For white at
    bottom, that's a8; for black at bottom, h1.
    """
    if orientation == "black":
        # row 0 → rank 1, col 0 → file h.
        rank = row + 1
        file_ = chr(ord("h") - col)
    else:
        rank = 8 - row
        file_ = chr(ord("a") + col)
    return f"{file_}{rank}"


def _infer_orientation(raw_grid: List[List[str]]) -> str:
    """Heuristic: which king sits on which half of the image?

    Standard orientation (white at bottom):
        bK in the top half (rows 0..3)
        wK in the bottom half (rows 4..7)
    Flipped (black at bottom): the opposite.

    Falls back to "majority of dark-pieces in the top half" when kings are
    misclassified or duplicated (which can happen on noisy photos).
    """
    wK_rows: List[int] = []
    bK_rows: List[int] = []
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            if raw_grid[r][c] == "wK":
                wK_rows.append(r)
            elif raw_grid[r][c] == "bK":
                bK_rows.append(r)

    if len(wK_rows) == 1 and len(bK_rows) == 1:
        # Unambiguous: trust the kings.
        return "white" if bK_rows[0] < wK_rows[0] else "black"

    # Fallback: count piece colours in top half.
    top_white = 0
    top_black = 0
    bottom_white = 0
    bottom_black = 0
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            label = raw_grid[r][c]
            if not label or label == "empty":
                continue
            colour = label[0]                            # 'w' or 'b'
            if r < GRID_SIZE // 2:
                if colour == "w":
                    top_white += 1
                else:
                    top_black += 1
            else:
                if colour == "w":
                    bottom_white += 1
                else:
                    bottom_black += 1

    # If the top half has more black pieces and the bottom half has more white
    # — standard orientation. Otherwise the board is flipped.
    if (top_black + bottom_white) >= (top_white + bottom_black):
        return "white"
    return "black"


def _sanity_check(grid: List[List[str]]) -> Dict[str, Any]:
    """Light-weight FEN plausibility check.

    Catches the most common classifier mistakes:

      * king count != 1 per side
      * pawns on rank 1 or rank 8 (impossible position)
      * too many pieces of one colour (> 16)
      * too many of a specific piece (e.g. > 8 pawns)

    Returns ``{valid: bool, issues: [...]}`` — we never reject the FEN, the
    caller decides what to do with the issues.
    """
    counts: Dict[str, int] = {label: 0 for label in LABELS}
    pawn_on_back_rank: List[str] = []

    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            label = grid[r][c]
            counts[label] = counts.get(label, 0) + 1
            if label == "wP" and r == 0:
                # white pawn on rank 8 (oriented from white's side)
                pawn_on_back_rank.append(_algebraic(r, c, "white"))
            if label == "bP" and r == GRID_SIZE - 1:
                pawn_on_back_rank.append(_algebraic(r, c, "white"))

    issues: List[str] = []
    if counts["wK"] != 1:
        issues.append(f"white king count = {counts['wK']} (expected 1)")
    if counts["bK"] != 1:
        issues.append(f"black king count = {counts['bK']} (expected 1)")

    white_total = sum(counts[lbl] for lbl in counts if lbl.startswith("w"))
    black_total = sum(counts[lbl] for lbl in counts if lbl.startswith("b"))
    if white_total > 16:
        issues.append(f"white piece count = {white_total} (> 16)")
    if black_total > 16:
        issues.append(f"black piece count = {black_total} (> 16)")
    if counts["wP"] > 8:
        issues.append(f"white pawn count = {counts['wP']} (> 8)")
    if counts["bP"] > 8:
        issues.append(f"black pawn count = {counts['bP']} (> 8)")
    if pawn_on_back_rank:
        issues.append(
            "pawns on first/last rank: " + ", ".join(sorted(pawn_on_back_rank))
        )

    return {
        "valid": len(issues) == 0,
        "issues": issues,
        "counts": counts,
    }


def _bbox_from_corners(corners: Sequence[Sequence[int]]) -> List[int]:
    """Axis-aligned bbox enclosing the corner list, in original image coords."""
    xs = [int(c[0]) for c in corners]
    ys = [int(c[1]) for c in corners]
    return [min(xs), min(ys), max(xs), max(ys)]


# ─── CLI ─────────────────────────────────────────────────────────────


def _cli(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="ADR-040 Stage 3: end-to-end universal board recognition.",
    )
    parser.add_argument("image", help="Input image (PNG/JPG/BMP).")
    parser.add_argument(
        "--model",
        help=f"Path to the board-recog ONNX model. Defaults to ${DEFAULT_MODEL_ENV}.",
    )
    parser.add_argument(
        "--orientation",
        choices=("auto", "white", "black"),
        default="auto",
        help="Board orientation. 'auto' infers from king positions.",
    )
    parser.add_argument(
        "--low-confidence-threshold",
        type=float,
        default=DEFAULT_LOW_CONFIDENCE_THRESHOLD,
        help="Cells with top-1 prob below this go to low_confidence_cells.",
    )
    parser.add_argument(
        "--unet-model",
        help="Optional UNet model path for board_detect fallback.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print the full result JSON to stdout. Otherwise print just FEN-board.",
    )
    args = parser.parse_args(argv)

    try:
        result = recognize(
            image_path=args.image,
            model_path=args.model,
            orientation=args.orientation,
            low_confidence_threshold=args.low_confidence_threshold,
            unet_model_path=args.unet_model,
        )
    except FileNotFoundError as exc:
        # Модель не передана / не существует — это инфраструктурная ошибка
        # (deploy-bug), её должен видеть алерт оператора. Возвращаем
        # exit 2 + stderr; в --json-режиме также печатаем заглушку, чтобы
        # вызывающий мог распарсить и отличить от других exit-кодов.
        print(f"board_recognize: {exc}", file=sys.stderr)
        if args.json:
            print(json.dumps({
                "success": False,
                "stage": "model_missing",
                "error": str(exc),
            }, ensure_ascii=False))
        return 2
    except Exception as exc:  # noqa: BLE001 — surface any unhandled failure
        print(f"board_recognize: unexpected error: {exc}", file=sys.stderr)
        if args.json:
            print(json.dumps({
                "success": False,
                "stage": "unexpected",
                "error": str(exc),
            }, ensure_ascii=False))
        return 1

    if not result.get("success"):
        if args.json:
            # KS-3095: в JSON-режиме negative-case (например `stage=detect`
            # «board detection failed») — это **нормальная диагностика**,
            # не падение процесса. Возвращаем exit 0; вызывающий парсит
            # stdout и сам решает, как маппить `stage` на HTTP-код
            # (board_not_detected vs inference_failed). До правки тут был
            # `return 1` → backend трактовал нормальный «не нашёл доску»
            # как 500 Internal Server Error.
            print(json.dumps(result, ensure_ascii=False))
            return 0
        print(
            f"failed at stage={result.get('stage')}: {result.get('error')}",
            file=sys.stderr,
        )
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        # Plain mode: FEN-board on stdout, sanity warnings on stderr.
        print(result["fen_board"])
        sanity = result.get("sanity") or {}
        for issue in sanity.get("issues", []):
            print(f"warning: {issue}", file=sys.stderr)
        lcc = result.get("low_confidence_cells") or []
        if lcc:
            joined = ", ".join(
                f"{cell['square']}={cell['predicted']}({cell['confidence']:.2f})"
                for cell in lcc
            )
            print(f"warning: low confidence cells: {joined}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
