#!/usr/bin/env python3
"""KS-3091 v4: генератор датасета досок целиком для object-detection
подхода (board-recog → детектор фигур, а не классификатор клеток).

Идея: научить модель находить фигуры по силуэту на любой доске, не
полагаясь на цвет/фон клетки. Inference тогда работает так:
  1. Corner-detector находит 4 угла доски (есть, KS-3091 v3).
  2. Perspective warp → квадрат BOARD_SIZE × BOARD_SIZE.
  3. YOLO-детектор находит все 12 классов фигур (wK..bP) с bbox.
  4. Центр каждого bbox мапится на клетку 8×8 → сборка FEN.

Этот модуль готовит train/val набор для шага 3.

Формат вывода — YOLO-style:
  /out_dir/
    images/train/board_000001.png
    images/val/board_000001.png
    labels/train/board_000001.txt   # одна строка на фигуру:
                                    # "class_idx cx cy w h"  (нормализованы 0..1)
    labels/val/...
    dataset.yaml                    # путь + классы

Классы 0..11 в порядке: wK, wQ, wR, wB, wN, wP, bK, bQ, bR, bB, bN, bP
(в соответствии с FEN-нотацией: 0=K, 5=P, плюс 6 для чёрных).
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw

# Локальные модули.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from background import render_background
from dataset_gen import (
    TRAIN_STYLES,
    VAL_STYLES,
    EDGE_CASE_FENS,
    _load_piece,
    _fen_to_grid,
    _square_kind,
    _collect_random_fens,
    _build_val_fen_list,
)


# ─── Config ──────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "data" / "v4-objdet"

# Размер одной клетки в собранной доске. Целая доска = 8 × CELL_SIZE.
CELL_SIZE = 64
BOARD_SIZE = CELL_SIZE * 8                 # 512×512

# Классы детектора: класс i соответствует фигуре.
# Порядок выбран так, чтобы совпадать с FEN char через .upper():
#   0..5: wK, wQ, wR, wB, wN, wP
#   6..11: bK, bQ, bR, bB, bN, bP
CLASS_NAMES: List[str] = [
    "wK", "wQ", "wR", "wB", "wN", "wP",
    "bK", "bQ", "bR", "bB", "bN", "bP",
]
LABEL_TO_CLASS: Dict[str, int] = {n: i for i, n in enumerate(CLASS_NAMES)}


# ─── Board rendering ─────────────────────────────────────────────────────

def _render_board_background(rng: random.Random, procedural: bool) -> Image.Image:
    """Сгенерировать фон 8×8 — как комбинацию render_background для каждой
    клетки (light/dark в шахматном порядке).

    Если procedural=False — используется фиксированная палитра (бежевый/
    коричневый) как в dataset_gen v2."""
    board = Image.new("RGB", (BOARD_SIZE, BOARD_SIZE), (240, 230, 200))
    for r in range(8):
        for c in range(8):
            bg_kind = _square_kind(r, c)
            if procedural:
                cell = render_background(bg_kind, rng)
            else:
                # Фиксированные плитки (как в v2 fixed_bg).
                color = (230, 215, 180) if bg_kind == "light" else (160, 110, 80)
                cell = Image.new("RGB", (CELL_SIZE, CELL_SIZE), color)
            if cell.size != (CELL_SIZE, CELL_SIZE):
                cell = cell.resize((CELL_SIZE, CELL_SIZE), Image.LANCZOS)
            board.paste(cell, (c * CELL_SIZE, r * CELL_SIZE))
    return board


def _place_pieces(
    board: Image.Image,
    grid: List[List[str]],
    style: str,
    rng: random.Random,
) -> List[Tuple[int, Tuple[float, float, float, float]]]:
    """Накладывает фигуры из grid на board (in-place). Возвращает список
    (class_idx, bbox) — bbox в пикселях изображения (x0, y0, x1, y1)."""
    annotations: List[Tuple[int, Tuple[float, float, float, float]]] = []
    for r, row in enumerate(grid):
        for c, label in enumerate(row):
            if label == "empty":
                continue
            piece_img = _load_piece(style, label)
            if piece_img.size != (CELL_SIZE, CELL_SIZE):
                piece_img = piece_img.resize((CELL_SIZE, CELL_SIZE), Image.LANCZOS)
            x0 = c * CELL_SIZE
            y0 = r * CELL_SIZE
            board.paste(piece_img, (x0, y0), piece_img)
            # bbox = вся клетка (силуэт фигуры в неё вписан).
            cls = LABEL_TO_CLASS[label]
            annotations.append((cls, (x0, y0, x0 + CELL_SIZE, y0 + CELL_SIZE)))
    return annotations


def _maybe_draw_grid_lines(
    board: Image.Image, rng: random.Random
) -> None:
    """С вероятностью 30% — нарисовать тонкие линии между клетками
    (имитация книги/UI с сеткой). Эта добавка тренирует устойчивость
    к разметке доски, а не к её отсутствию."""
    if rng.random() >= 0.3:
        return
    draw = ImageDraw.Draw(board)
    ink_v = rng.randint(40, 120)
    ink = (ink_v, ink_v, ink_v)
    width = rng.choice([1, 1, 2])
    for i in range(9):
        x = i * CELL_SIZE
        draw.line([(x, 0), (x, BOARD_SIZE)], fill=ink, width=width)
        draw.line([(0, x), (BOARD_SIZE, x)], fill=ink, width=width)


def render_board_with_annotations(
    fen: str,
    style: str,
    rng: random.Random,
    procedural_bg: bool = True,
) -> Tuple[Image.Image, List[Tuple[int, Tuple[float, float, float, float]]]]:
    """Сгенерировать одну доску + bbox-аннотации.

    Возвращает (PIL.Image RGB BOARD_SIZE×BOARD_SIZE, [(class_idx, (x0,y0,x1,y1)), ...]).
    """
    grid = _fen_to_grid(fen)
    board = _render_board_background(rng, procedural=procedural_bg)
    anns = _place_pieces(board, grid, style, rng)
    _maybe_draw_grid_lines(board, rng)
    return board, anns


# ─── YOLO label encoding ────────────────────────────────────────────────

def encode_yolo_line(
    cls: int, bbox: Tuple[float, float, float, float],
    img_w: int, img_h: int,
) -> str:
    x0, y0, x1, y1 = bbox
    cx = (x0 + x1) / 2 / img_w
    cy = (y0 + y1) / 2 / img_h
    w = (x1 - x0) / img_w
    h = (y1 - y0) / img_h
    return f"{cls} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}"


# ─── Generation pipeline ────────────────────────────────────────────────

def generate_split(
    fens: List[str],
    styles: List[str],
    out_images_dir: Path,
    out_labels_dir: Path,
    seed: int,
    procedural_bg: bool,
    prefix: str,
) -> Dict[str, int]:
    """Сгенерировать одну сплит-выборку — каждую (FEN × style) → один файл.

    Имя: {prefix}_{idx:06d}.png + .txt
    """
    out_images_dir.mkdir(parents=True, exist_ok=True)
    out_labels_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    n_total = len(fens) * len(styles)
    print(
        f"[{prefix}] generating {n_total} boards ({len(fens)} FEN × {len(styles)} styles) "
        f"→ {out_images_dir.parent}",
        file=sys.stderr,
    )
    t0 = time.time()
    class_counts: Dict[int, int] = {i: 0 for i in range(len(CLASS_NAMES))}
    idx = 0
    for fen in fens:
        for style in styles:
            board, anns = render_board_with_annotations(
                fen, style, rng, procedural_bg=procedural_bg,
            )
            img_path = out_images_dir / f"{prefix}_{idx:06d}.png"
            lbl_path = out_labels_dir / f"{prefix}_{idx:06d}.txt"
            board.save(img_path, format="PNG")
            with lbl_path.open("w") as fh:
                for cls, bbox in anns:
                    fh.write(encode_yolo_line(cls, bbox, BOARD_SIZE, BOARD_SIZE) + "\n")
                    class_counts[cls] += 1
            idx += 1
            if idx % 100 == 0 or idx == n_total:
                el = time.time() - t0
                rate = idx / max(el, 0.01)
                eta = (n_total - idx) / max(rate, 0.01)
                print(
                    f"[{prefix}] {idx}/{n_total} ({rate:.0f}/s, ETA {eta:.0f}s)",
                    file=sys.stderr,
                )
    return {
        "n_boards": n_total,
        "class_counts": class_counts,
    }


def write_dataset_yaml(out_dir: Path) -> None:
    """Минимальный dataset.yaml для ultralytics YOLO."""
    cfg = (
        f"path: {out_dir.resolve()}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"nc: {len(CLASS_NAMES)}\n"
        f"names: {CLASS_NAMES}\n"
    )
    (out_dir / "dataset.yaml").write_text(cfg)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    ap.add_argument(
        "--n-train-fens", type=int, default=300,
        help="Сколько уникальных FEN для train. Реальный размер сплита = "
             "n_train_fens × len(TRAIN_STYLES).",
    )
    ap.add_argument(
        "--n-val-fens", type=int, default=50,
        help="Сколько FEN для val (включая 9 edge-case'ов от chess-expert).",
    )
    ap.add_argument(
        "--no-procedural-bg", action="store_true",
        help="Использовать фиксированный фон (без штриховки/перлина/...). "
             "По умолчанию — procedural-bg для инвариантности к фону.",
    )
    ap.add_argument(
        "--max-train-styles", type=int, default=10,
        help="Сколько стилей из TRAIN_STYLES брать (берутся первые N). "
             "Уменьшение ускоряет генерацию.",
    )
    ap.add_argument(
        "--seed", type=int, default=3091,
    )
    args = ap.parse_args(argv)

    procedural_bg = not args.no_procedural_bg
    train_styles = TRAIN_STYLES[: args.max_train_styles]
    val_styles = VAL_STYLES

    print(f"[plan] train_styles ({len(train_styles)}): {train_styles}", file=sys.stderr)
    print(f"[plan] val_styles   ({len(val_styles)}): {val_styles}", file=sys.stderr)
    print(f"[plan] procedural_bg={procedural_bg}", file=sys.stderr)

    # Train FENs — детерминированная случайная выборка.
    train_fens = _collect_random_fens(args.n_train_fens, seed=args.seed)
    # Val FENs — фиксированная выборка с edge-case'ами.
    val_fens_all, _ = _build_val_fen_list()
    val_fens = val_fens_all[: args.n_val_fens]

    out = args.out_dir
    out.mkdir(parents=True, exist_ok=True)

    train_stats = generate_split(
        fens=train_fens,
        styles=train_styles,
        out_images_dir=out / "images" / "train",
        out_labels_dir=out / "labels" / "train",
        seed=args.seed + 100,
        procedural_bg=procedural_bg,
        prefix="train",
    )
    val_stats = generate_split(
        fens=val_fens,
        styles=val_styles,
        out_images_dir=out / "images" / "val",
        out_labels_dir=out / "labels" / "val",
        seed=args.seed + 200,
        procedural_bg=False,  # val всегда чистый, для воспроизводимой метрики
        prefix="val",
    )

    write_dataset_yaml(out)

    manifest = {
        "version": "v4-objdet",
        "task": "KS-3091 v4 (object detection of pieces)",
        "board_size": BOARD_SIZE,
        "cell_size": CELL_SIZE,
        "class_names": CLASS_NAMES,
        "train_styles": train_styles,
        "val_styles": val_styles,
        "procedural_bg": procedural_bg,
        "train": train_stats,
        "val": val_stats,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"[done] wrote {out / 'manifest.json'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
