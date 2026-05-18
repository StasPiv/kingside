#!/usr/bin/env python3
"""
Board-recog dataset v2 generator (KS-3091, ADR-040-v2 §1 / §6 этап B).

Радикально отличается от v1 (KS-2360):

* v1 расщеплял train/val/test ПО ПОЗИЦИЯМ внутри одного и того же piece-set'а.
  Модель видела kingside_default/cburnett/merida в обеих корзинах и в итоге
  стала «классификатором знакомых спрайтов» — что и сломалось на проде
  17.05.2026.
* v2 расщепляет train/val ПО ПИРС-СЕТАМ:
    - TRAIN_STYLES — 9 чужих open-source стилей с lichess, которых нет на
      проде. На них модель учится.
    - VAL_STYLES — 7 целевых стилей (kingside_default + 4 lichess + 2 chess.com
      proxy через lichess-стили), которых модель в обучении НЕ ВИДИТ.
  Инвариант ``set(TRAIN_STYLES) & set(VAL_STYLES) == set()`` проверяется
  и в коде (assert), и юнит-тестом.

## Train-генерация (--style-set train|both)

Train — это **независимые клетки**, без FEN-источника. Для каждой клетки:

1. Класс сэмплится из ``CLASS_WEIGHTS`` (chess-expert §4: empty 22%,
   pawn_w/pawn_b по 11%, остальные 10 классов по 5.6%).
2. Piece-set выбирается случайно из ``TRAIN_STYLES`` (mixed-style).
3. Цвет клетки — процедурный HSV-сэмплинг (light/dark) — не фиксированные
   палитры конкретных платформ.
4. Если класс != "empty" — рендерим SVG/WebP фигуры на фоне.
5. Сохраняем PNG-байты в HDF5 + метку.

Аугментация (Albumentations: Perspective, HueSaturationValue, RGBShift,
Downscale, JPEG, Sharpen) применяется НЕ ЗДЕСЬ — она в
`training/dataset.py:build_train_transform`. Сэмплинг и аугментация
разнесены, как требует chess-expert (иначе один и тот же augmented tile
попадёт в батч N раз при oversample).

## Val-генерация (--style-set val|both)

Val — FEN-based, чтобы можно было считать end-to-end FEN-match (этап D).
500 фиксированных FEN'ов (491 случайных детерминированных + 9 edge-case
от chess-expert) × 7 стилей × 64 клетки = 224 000 клеток. SHA256 списка
FEN'ов фиксируется в manifest — между запусками не меняется.

## Output layout

::

    data/v2/
        cells_train.h5     — packed train cells (PNG bytes + labels)
        cells_val.h5       — packed val cells (PNG bytes + labels)
        edge_case_fens.json
        val_fens.json      — 500 FEN'ов val-выборки + их sha256
        manifest_v2.json   — стили (usage, license, SHA256), счётчики

## CLI

::

    python dataset_gen.py --style-set both --n-train 1500000
    python dataset_gen.py --style-set train --dry-run
    python dataset_gen.py --style-set val
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image

# ─── Configuration ────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parents[2]  # packages/board-image-to-fen
STYLES_DIR = ROOT / "styles_cache"
DATA_DIR = ROOT / "data" / "v2"
MANIFEST_PATH = DATA_DIR / "manifest_v2.json"

CELL_SIZE = 64
BOARD_SIZE = CELL_SIZE * 8

# ─── Style sets (ADR-040-v2 §1, chess-expert KS-3091) ────────────────────

# 9 chosen by chess-expert: pirouetti исключён (визуально близок к chess.com_
# classic, утечка в val), gioco добавлен взамен. Покрытие визуальных классов:
#   modern flat        — caliente, riohacha, dubrovny, tatiana
#   fantasy/heraldic   — fantasy, monarchy, kosal
#   geometric/minimal  — letter
#   stylized rounded   — gioco
TRAIN_STYLES: List[str] = [
    "lichess_tatiana",
    "lichess_caliente",
    "lichess_fantasy",
    "lichess_gioco",
    "lichess_riohacha",
    "lichess_dubrovny",
    "lichess_kosal",
    # KS-3091 user-review: lichess_letter исключён — рисует фигуры
    # буквами (K/Q/R/B/N/P), а не силуэтами. Модель должна учиться
    # силуэту, не глифу буквы → шум для трейна.
    "lichess_monarchy",
]

# 7 целевых стилей — те, что модель встречает на проде. В train ни один из
# них не входит. chesscom_* — closed IP, используем lichess-прокси (явно
# помечаются в manifest); инвариант изоляции это не нарушает (прокси-стили
# не пересекаются с TRAIN_STYLES).
VAL_STYLES: List[str] = [
    "kingside_default",
    "lichess_cburnett",
    "lichess_merida",
    "lichess_wikipedia",
    "lichess_alpha",
    "lichess_staunty",      # proxy for chesscom_classic
    "lichess_pirouetti",    # proxy for chesscom_modern
]

# 🔴 Hard invariant: train ∩ val = ∅. Если кто-то добавит стиль в обе
# корзины — упадём на старте, до того как сжечь часы CPU.
_OVERLAP = set(TRAIN_STYLES) & set(VAL_STYLES)
assert not _OVERLAP, (
    f"train ∩ val must be empty, got overlap: {sorted(_OVERLAP)}. "
    f"This is the v1 mistake ADR-040-v2 is fixing — do not repeat it."
)

VAL_PROXY_NOTE: Dict[str, str] = {
    "lichess_staunty":   "proxy_for_chesscom_classic (closed IP not redistributable)",
    "lichess_pirouetti": "proxy_for_chesscom_modern (closed IP not redistributable)",
}

# ─── Class set + balance (ADR-040-v2 §4 chess-expert) ────────────────────

LABELS: List[str] = [
    "empty",
    "wK", "wQ", "wR", "wB", "wN", "wP",
    "bK", "bQ", "bR", "bB", "bN", "bP",
]
LABEL_TO_IDX: Dict[str, int] = {l: i for i, l in enumerate(LABELS)}
PIECE_LABELS: List[str] = LABELS[1:]   # 12 фигур

# chess-expert KS-3091 §4: 22 / 11 / 11 / 5.6×10 = 100.0
CLASS_WEIGHTS: Dict[str, float] = {
    "empty": 22.0,
    "wP":    11.0,
    "bP":    11.0,
    "wK":     5.6,
    "wQ":     5.6,
    "wR":     5.6,
    "wB":     5.6,
    "wN":     5.6,
    "bK":     5.6,
    "bQ":     5.6,
    "bR":     5.6,
    "bB":     5.6,
    "bN":     5.6,
}
assert abs(sum(CLASS_WEIGHTS.values()) - 100.0) < 1e-6
assert set(CLASS_WEIGHTS) == set(LABELS)

# ─── HSV palette sampling ────────────────────────────────────────────────

# Светлая клетка — высокая Value, тёмная — низкая. Hue свободно по кругу,
# Saturation умеренный (десатурированные доски тоже бывают). chess-expert §1.1:
# процедурно, не пресеты конкретных платформ.
LIGHT_HSV_RANGES = {"H": (0, 360), "S": (10, 55), "V": (75, 100)}
DARK_HSV_RANGES  = {"H": (0, 360), "S": (15, 65), "V": (25, 60)}


def sample_hsv(rng: random.Random, bg_kind: str) -> Tuple[float, float, float]:
    ranges = LIGHT_HSV_RANGES if bg_kind == "light" else DARK_HSV_RANGES
    h = rng.uniform(*ranges["H"])
    s = rng.uniform(*ranges["S"]) / 100.0
    v = rng.uniform(*ranges["V"]) / 100.0
    return h, s, v


def hsv_to_rgb(h: float, s: float, v: float) -> Tuple[int, int, int]:
    """h ∈ [0,360), s,v ∈ [0,1]. Возвращает 8-bit RGB."""
    import colorsys
    r, g, b = colorsys.hsv_to_rgb((h % 360) / 360.0, s, v)
    return int(round(r * 255)), int(round(g * 255)), int(round(b * 255))


# ─── Piece bitmap cache ──────────────────────────────────────────────────

# Один разрезанный SVG/WebP в RGBA-битмап 64×64. Кэш per-process, ключ
# (style, piece). Загружается лениво.
_PIECE_CACHE: Dict[Tuple[str, str], Image.Image] = {}


def _load_piece(style: str, piece: str) -> Image.Image:
    key = (style, piece)
    cached = _PIECE_CACHE.get(key)
    if cached is not None:
        return cached
    style_dir = STYLES_DIR / style
    if not style_dir.is_dir():
        raise FileNotFoundError(f"style dir missing: {style_dir}")
    # SVG приоритетнее, fallback WebP / PNG.
    for ext in ("svg", "webp", "png"):
        path = style_dir / f"{piece}.{ext}"
        if not path.is_file():
            continue
        if ext == "svg":
            import cairosvg
            png_bytes = cairosvg.svg2png(
                bytestring=path.read_bytes(),
                output_width=CELL_SIZE,
                output_height=CELL_SIZE,
            )
            img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
        else:
            img = Image.open(path).convert("RGBA")
            if img.size != (CELL_SIZE, CELL_SIZE):
                img = img.resize((CELL_SIZE, CELL_SIZE), Image.LANCZOS)
        _PIECE_CACHE[key] = img
        return img
    raise FileNotFoundError(
        f"no piece bitmap for {style}/{piece} (looked for .svg/.webp/.png)"
    )


COORD_GLYPHS: List[str] = list("12345678abcdefgh")
COORD_OVERLAY_PROB: float = 0.10  # KS-3091 fix: реальные board-detect крой
# часто оставляет внутри клеток координатные подписи "1..8" / "a..h".
# v1-модель путала их с фигурами (см. отчёт по user screenshot 18.05.2026 —
# 3 ошибки на a-колонке из-за цифр). Учим модель: с вероятностью 10%
# рисуем случайную цифру/букву в углу клетки. Метка не меняется (если
# клетка была empty — остаётся empty).


def _font_for_coord() -> "ImageFont.ImageFont":
    """Один маленький bitmap-фонт DejaVu или fallback на default."""
    try:
        from PIL import ImageFont
        return ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            size=14,
        )
    except OSError:
        from PIL import ImageFont
        return ImageFont.load_default()


_COORD_FONT = None


def _maybe_overlay_coord(
    cell: Image.Image,
    bg_kind: str,
    rng: random.Random,
) -> None:
    """С вероятностью COORD_OVERLAY_PROB накладывает случайную цифру/букву
    в один из 4 углов клетки. Цвет — контрастный к фону (светлая клетка
    получает тёмный глиф, тёмная — светлый), с лёгким альфа-варьированием,
    чтобы было реалистично.

    Использует in-place mutation (cell.paste / draw)."""
    if rng.random() >= COORD_OVERLAY_PROB:
        return
    global _COORD_FONT
    if _COORD_FONT is None:
        _COORD_FONT = _font_for_coord()
    from PIL import ImageDraw
    draw = ImageDraw.Draw(cell)
    glyph = rng.choice(COORD_GLYPHS)
    # Размер шрифта случайный (имитация разных стилей координат).
    # Используем простой draw.text — для разных размеров либо разные фонты,
    # либо просто скейл изображения. Один маленький фонт достаточно.
    # 4 угла + лёгкий jitter
    corner = rng.choice([
        (3, 1),                                   # top-left
        (CELL_SIZE - 12, 1),                      # top-right
        (3, CELL_SIZE - 16),                      # bottom-left
        (CELL_SIZE - 12, CELL_SIZE - 16),         # bottom-right
    ])
    # Цвет — контраст к фону.
    if bg_kind == "light":
        base = (rng.randint(20, 90),) * 3
    else:
        base = (rng.randint(170, 240),) * 3
    draw.text(corner, glyph, fill=base, font=_COORD_FONT)


def render_cell(
    label: str,
    style: str,
    bg_kind: str,
    rng: random.Random,
) -> Image.Image:
    """Один шаг рендера: цветной фон + (опционально) фигура поверх +
    с малой вероятностью наложить координатный глиф (KS-3091 follow-up).
    """
    bg_rgb = hsv_to_rgb(*sample_hsv(rng, bg_kind))
    cell = Image.new("RGB", (CELL_SIZE, CELL_SIZE), bg_rgb)
    if label != "empty":
        piece_img = _load_piece(style, label)
        cell.paste(piece_img, (0, 0), piece_img)
    _maybe_overlay_coord(cell, bg_kind, rng)
    return cell


def encode_png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


# ─── Class sampling ──────────────────────────────────────────────────────

def _build_class_sampler(rng_seed: int) -> "WeightedSampler":
    return WeightedSampler(
        items=list(CLASS_WEIGHTS.keys()),
        weights=list(CLASS_WEIGHTS.values()),
        seed=rng_seed,
    )


class WeightedSampler:
    """Stateful weighted sampler: numpy.random.choice — но с фиксированным
    seed, чтобы прогоны были воспроизводимы.
    """
    def __init__(self, items: List[str], weights: List[float], seed: int) -> None:
        self.items = items
        weights_arr = np.array(weights, dtype=np.float64)
        self.probs = weights_arr / weights_arr.sum()
        self.rng = np.random.default_rng(seed)

    def sample(self) -> str:
        idx = self.rng.choice(len(self.items), p=self.probs)
        return self.items[int(idx)]


# ─── Train generation ────────────────────────────────────────────────────

def generate_train(
    n_cells: int,
    seed: int,
    out_path: Path,
) -> Dict[str, object]:
    """Сгенерировать ``n_cells`` независимых клеток в HDF5.

    Каждая клетка:
      - класс из CLASS_WEIGHTS
      - стиль random из TRAIN_STYLES (mixed-style)
      - bg light/dark 50/50
      - HSV-сэмплинг цвета
      - render
      - PNG → HDF5 'cells' (variable-length bytes) + 'labels' (uint8)
    """
    import h5py

    sampler = _build_class_sampler(seed)
    style_rng = random.Random(seed + 1)
    bg_rng = random.Random(seed + 2)
    color_rng = random.Random(seed + 3)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    label_counts: Dict[str, int] = {l: 0 for l in LABELS}
    style_counts: Dict[str, int] = {s: 0 for s in TRAIN_STYLES}

    print(f"[train] generating {n_cells:,} cells → {out_path}", file=sys.stderr)
    t0 = time.time()
    with h5py.File(out_path, "w") as fh:
        dt = h5py.vlen_dtype(np.uint8)
        cells_ds = fh.create_dataset("cells", shape=(n_cells,), dtype=dt)
        labels_ds = fh.create_dataset(
            "labels", shape=(n_cells,), dtype=np.uint8,
        )
        # Track style per cell for downstream diagnostics.
        style_ds = fh.create_dataset(
            "styles", shape=(n_cells,), dtype=h5py.string_dtype(encoding="ascii"),
        )
        for i in range(n_cells):
            label = sampler.sample()
            style = style_rng.choice(TRAIN_STYLES)
            bg = "light" if bg_rng.random() < 0.5 else "dark"
            img = render_cell(label, style, bg, color_rng)
            png = encode_png(img)
            cells_ds[i] = np.frombuffer(png, dtype=np.uint8)
            labels_ds[i] = LABEL_TO_IDX[label]
            style_ds[i] = style.encode("ascii")
            label_counts[label] += 1
            style_counts[style] += 1
            if (i + 1) % 50000 == 0 or i + 1 == n_cells:
                elapsed = time.time() - t0
                rate = (i + 1) / max(elapsed, 0.01)
                eta = (n_cells - i - 1) / max(rate, 0.01)
                print(
                    f"[train] {i + 1:,}/{n_cells:,} ({rate:.0f}/s, ETA {eta:.0f}s)",
                    file=sys.stderr,
                )

    print(f"[train] done in {time.time() - t0:.0f}s", file=sys.stderr)
    return {
        "n_cells": n_cells,
        "label_counts": label_counts,
        "style_counts": style_counts,
        "h5_path": str(out_path.relative_to(DATA_DIR.parent)),
    }


# ─── Val generation (FEN-based) ──────────────────────────────────────────

# 9 трудных позиций от chess-expert (KS-3091 §3). Подмешиваются к
# случайной выборке FEN'ов, чтобы val ловил клинические edge-кейсы.
EDGE_CASE_FENS: List[str] = [
    "4k3/8/8/8/8/8/8/4K3 w - - 0 1",                 # 1. KvK
    "4k3/8/4K3/4Q3/8/8/8/8 w - - 0 1",               # 2. K+Q vs K
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",  # 3. start
    "4k3/8/8/8/8/8/PPPPPPPP/4K3 w - - 0 1",          # 4. 8 pawns + kings
    "4k3/8/8/3NN3/3NN3/8/8/4K3 w - - 0 1",           # 5. 4 white knights
    "4k3/8/8/8/8/Q2Q2Q1/Q2Q4/4K3 w - - 0 1",         # 6. 5 white queens
    "4N2k/8/8/8/8/8/8/4K3 b - - 0 1",                # 7. promotion to N
    "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",          # 8. full castling
    "8/8/8/3pP3/3Pp3/8/8/4K2k w - - 0 1",            # 9. symmetric pawns
]

VAL_FENS_PER_STYLE = 500  # ровно столько FEN'ов на стиль → 500 × 7 × 64 = 224 000


def _collect_random_fens(target: int, seed: int) -> List[str]:
    """Детерминированно собирает ``target`` уникальных FEN'ов случайным
    blowingup от стартовой позиции. БД не используется — нужна
    воспроизводимость между запусками без DB-доступа.
    """
    import chess
    rng = random.Random(seed)
    out: List[str] = []
    seen: set = set()
    attempts = 0
    while len(out) < target and attempts < target * 4:
        attempts += 1
        board = chess.Board()
        depth = rng.randint(8, 50)
        for _ in range(depth):
            moves = list(board.legal_moves)
            if not moves:
                break
            board.push(rng.choice(moves))
            if board.is_game_over():
                break
        fen = board.fen()
        if fen in seen:
            continue
        seen.add(fen)
        out.append(fen)
    if len(out) < target:
        raise RuntimeError(f"failed to gather {target} unique FENs (got {len(out)})")
    return out


def _build_val_fen_list() -> Tuple[List[str], str]:
    """Возвращает (fens, sha256) — фиксированную выборку val-FEN'ов.

    9 edge-case + 491 случайных (seed=2360) — итого 500. SHA256 списка
    фиксируется и пишется в manifest, чтобы между запусками выборка
    оставалась идентичной (acceptance: «val зафиксирован хешем»).
    """
    random_part = _collect_random_fens(VAL_FENS_PER_STYLE - len(EDGE_CASE_FENS), seed=2360)
    fens = EDGE_CASE_FENS + random_part
    assert len(fens) == VAL_FENS_PER_STYLE, f"got {len(fens)} fens"
    sha = hashlib.sha256("\n".join(fens).encode()).hexdigest()
    return fens, sha


def _fen_to_grid(fen: str) -> List[List[str]]:
    """FEN board part → 8×8 grid of labels.

    Row 0 = rank 8 (top), Row 7 = rank 1 (bottom). Колонки a..h слева-направо.
    Возвращает "empty" / "wK" / ... / "bP" в каждой клетке.
    """
    board_part = fen.split()[0]
    grid: List[List[str]] = []
    for row_str in board_part.split("/"):
        row: List[str] = []
        for ch in row_str:
            if ch.isdigit():
                row.extend(["empty"] * int(ch))
            else:
                color = "w" if ch.isupper() else "b"
                row.append(f"{color}{ch.upper()}")
        if len(row) != 8:
            raise ValueError(f"bad FEN row: {row_str!r}")
        grid.append(row)
    if len(grid) != 8:
        raise ValueError(f"bad FEN: {fen!r}")
    return grid


def _square_kind(row_from_top: int, col: int) -> str:
    """light/dark в стандартной ориентации (white at bottom). a1 (row 7
    col 0) — dark."""
    rank_from_a1 = 7 - row_from_top
    return "light" if (col + rank_from_a1) % 2 == 1 else "dark"


def generate_val(out_path: Path) -> Dict[str, object]:
    """Сгенерировать val-сет 7 × 500 × 64 = 224 000 клеток."""
    import h5py

    fens, fen_sha = _build_val_fen_list()
    n_cells = len(VAL_STYLES) * VAL_FENS_PER_STYLE * 64
    print(
        f"[val] generating {n_cells:,} cells "
        f"({len(VAL_STYLES)} styles × {VAL_FENS_PER_STYLE} FENs × 64) → {out_path}",
        file=sys.stderr,
    )

    color_rng = random.Random(2361)  # отдельный seed для val палитр
    out_path.parent.mkdir(parents=True, exist_ok=True)
    label_counts: Dict[str, int] = {l: 0 for l in LABELS}
    per_style_counts: Dict[str, Dict[str, int]] = {
        s: {l: 0 for l in LABELS} for s in VAL_STYLES
    }

    t0 = time.time()
    with h5py.File(out_path, "w") as fh:
        dt = h5py.vlen_dtype(np.uint8)
        cells_ds = fh.create_dataset("cells", shape=(n_cells,), dtype=dt)
        labels_ds = fh.create_dataset("labels", shape=(n_cells,), dtype=np.uint8)
        style_ds = fh.create_dataset(
            "styles", shape=(n_cells,),
            dtype=h5py.string_dtype(encoding="ascii"),
        )
        fen_idx_ds = fh.create_dataset(
            "fen_idx", shape=(n_cells,), dtype=np.uint16,
        )
        sq_ds = fh.create_dataset("square", shape=(n_cells,), dtype=np.uint8)

        i = 0
        for style in VAL_STYLES:
            for fen_idx, fen in enumerate(fens):
                grid = _fen_to_grid(fen)
                for sq in range(64):
                    r, c = divmod(sq, 8)
                    label = grid[r][c]
                    bg = _square_kind(r, c)
                    img = render_cell(label, style, bg, color_rng)
                    png = encode_png(img)
                    cells_ds[i] = np.frombuffer(png, dtype=np.uint8)
                    labels_ds[i] = LABEL_TO_IDX[label]
                    style_ds[i] = style.encode("ascii")
                    fen_idx_ds[i] = fen_idx
                    sq_ds[i] = sq
                    label_counts[label] += 1
                    per_style_counts[style][label] += 1
                    i += 1
                    if i % 50000 == 0:
                        elapsed = time.time() - t0
                        print(
                            f"[val] {i:,}/{n_cells:,} ({i/max(elapsed,0.01):.0f}/s)",
                            file=sys.stderr,
                        )
        assert i == n_cells

        # Сохраним сами FEN'ы внутри h5 для воспроизводимости.
        fh.create_dataset(
            "val_fens", data=np.array(fens, dtype=h5py.string_dtype()),
        )
        fh.attrs["val_fens_sha256"] = fen_sha

    # Дополнительно дублируем FEN'ы наружу в JSON — удобно для рецензии.
    (DATA_DIR / "val_fens.json").write_text(
        json.dumps({"sha256": fen_sha, "fens": fens, "edge_case_count": len(EDGE_CASE_FENS)},
                   indent=2),
        encoding="utf-8",
    )
    print(f"[val] done in {time.time() - t0:.0f}s", file=sys.stderr)
    return {
        "n_cells": n_cells,
        "n_fens": VAL_FENS_PER_STYLE,
        "fen_sha256": fen_sha,
        "label_counts": label_counts,
        "per_style_counts": per_style_counts,
        "h5_path": str(out_path.relative_to(DATA_DIR.parent)),
    }


# ─── Style metadata + manifest ───────────────────────────────────────────

# Лицензии на 17.05.2026 по COPYING.md в lichess-org/lila (master).
# По CC-BY-NC-SA пользователь решил включать (KS-3091): attribution
# обязателен в UI Credits + manifest, коммерческие риски приняты.
_STYLE_LICENSE: Dict[str, Dict[str, str]] = {
    "lichess_tatiana":   {"license": "CC-BY-NC-SA-4.0", "attribution": "sadsnake1"},
    "lichess_caliente":  {"license": "CC-BY-NC-SA-4.0", "attribution": "avi (github.com/avi-0/caliente)"},
    "lichess_fantasy":   {"license": "MIT",              "attribution": "Maurizio Monge (github.com/maurimo/chess-art)"},
    "lichess_gioco":     {"license": "CC-BY-NC-SA-4.0", "attribution": "sadsnake1"},
    "lichess_riohacha":  {"license": "lichess COPYING.md not specified — treated as AGPLv3+ (lila default)", "attribution": "unknown (lila contributor)"},
    "lichess_dubrovny":  {"license": "CC-BY-NC-SA-4.0", "attribution": "sadsnake1"},
    "lichess_kosal":     {"license": "lichess COPYING.md not specified — treated as AGPLv3+ (lila default)", "attribution": "unknown (lila contributor)"},
    "lichess_letter":    {"license": "AGPLv3+",         "attribution": "usolando (lichess.org/@/usolando)"},
    "lichess_monarchy":  {"license": "CC-BY-NC-SA-4.0", "attribution": "slither77 (github.com/slither77)"},
    # Val-стили (целевые)
    "kingside_default":   {"license": "MIT (react-chessboard); pieces ≡ cburnett (GPLv2+)", "attribution": "Colin M.L. Burnett (pieces); react-chessboard MIT (wrapper)"},
    "lichess_cburnett":   {"license": "GPLv2+", "attribution": "Colin M.L. Burnett"},
    "lichess_merida":     {"license": "GPLv2+", "attribution": "Armando Hernandez Marroquin"},
    "lichess_wikipedia":  {"license": "Public Domain / CC BY-SA 3.0",
                           "attribution": "Colin M.L. Burnett (SCID set via Wikimedia Commons)"},
    "lichess_alpha":      {"license": "Eric Bentzen — free for personal non-commercial use",
                           "attribution": "Eric Bentzen"},
    "lichess_staunty":    {"license": "CC-BY-NC-SA-4.0", "attribution": "sadsnake1"},
    "lichess_pirouetti":  {"license": "AGPLv3+",         "attribution": "pirouetti (lichess.org/@/pirouetti)"},
}


def _style_dir_sha(style: str) -> str:
    """SHA256 от отсортированного содержимого style_dir (имена + байты)."""
    h = hashlib.sha256()
    style_dir = STYLES_DIR / style
    if not style_dir.is_dir():
        return ""
    for name in sorted(os.listdir(style_dir)):
        p = style_dir / name
        if not p.is_file():
            continue
        h.update(name.encode())
        h.update(b"\0")
        h.update(p.read_bytes())
    return h.hexdigest()


def _style_meta(style: str, usage: str) -> Dict[str, object]:
    meta = dict(_STYLE_LICENSE.get(style, {"license": "unknown", "attribution": "unknown"}))
    meta["name"] = style
    meta["usage"] = usage
    meta["sha256"] = _style_dir_sha(style)
    if usage == "val_only" and style in VAL_PROXY_NOTE:
        meta["proxy_note"] = VAL_PROXY_NOTE[style]
    return meta


def write_manifest(
    train_stats: Optional[Dict[str, object]],
    val_stats: Optional[Dict[str, object]],
) -> None:
    manifest: Dict[str, object] = {
        "version": "v2",
        "task": "KS-3091",
        "adr": "ADR-040-v2",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cell_size": CELL_SIZE,
        "labels": LABELS,
        "label_to_idx": LABEL_TO_IDX,
        "class_weights_pct": CLASS_WEIGHTS,
        "isolation_invariant": {
            "train_styles": TRAIN_STYLES,
            "val_styles":   VAL_STYLES,
            "intersection": sorted(set(TRAIN_STYLES) & set(VAL_STYLES)),
            "valid":        not bool(set(TRAIN_STYLES) & set(VAL_STYLES)),
        },
        "external_datasets": {
            "ChessReD": {
                "license": "CC-BY-4.0",
                "attribution": "Wölflein & Arandjelović (2023)",
                "source": "https://github.com/georg-wolflein/chesscog (and follow-up)",
                "status": "pending_integration (KS-3091 follow-up)",
            },
            "Chess Cog": {
                "license": "MIT",
                "attribution": "Czyzewski et al.",
                "source": "https://github.com/maciejczyzewski/neural-chessboard",
                "status": "pending_integration (KS-3091 follow-up)",
            },
        },
        "styles": [_style_meta(s, "train_only") for s in TRAIN_STYLES]
                + [_style_meta(s, "val_only")   for s in VAL_STYLES],
        "train": train_stats,
        "val":   val_stats,
        "s3_prefix": "s3://kingside-ml/datasets/board-recog/v2/",
    }
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"[manifest] wrote {MANIFEST_PATH}", file=sys.stderr)


# ─── CLI ─────────────────────────────────────────────────────────────────

def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--style-set", choices=("train", "val", "both"), default="both",
        help="What to generate.",
    )
    ap.add_argument(
        "--n-train", type=int, default=1_500_000,
        help="Number of train cells (ADR acceptance ≥ 1.5M).",
    )
    ap.add_argument(
        "--seed", type=int, default=3091,
        help="Random seed for train cell generation.",
    )
    ap.add_argument(
        "--dry-run", action="store_true",
        help="Print plan, do not write h5 files.",
    )
    args = ap.parse_args(argv)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Sanity: проверим, что все стили физически есть в styles_cache.
    missing: List[str] = []
    for s in TRAIN_STYLES + VAL_STYLES:
        if not (STYLES_DIR / s).is_dir():
            missing.append(s)
    if missing:
        print(
            f"[fatal] missing style dirs: {missing}. "
            f"Run scripts/fetch_styles.sh first.",
            file=sys.stderr,
        )
        return 2

    print(f"[plan] style_set={args.style_set}", file=sys.stderr)
    print(f"[plan] TRAIN_STYLES ({len(TRAIN_STYLES)}): {TRAIN_STYLES}", file=sys.stderr)
    print(f"[plan] VAL_STYLES   ({len(VAL_STYLES)}):   {VAL_STYLES}", file=sys.stderr)
    print(f"[plan] isolation invariant: train ∩ val = {sorted(set(TRAIN_STYLES) & set(VAL_STYLES))}",
          file=sys.stderr)

    if args.dry_run:
        print("[dry-run] not writing h5", file=sys.stderr)
        return 0

    train_stats = None
    if args.style_set in ("train", "both"):
        train_stats = generate_train(
            n_cells=args.n_train,
            seed=args.seed,
            out_path=DATA_DIR / "cells_train.h5",
        )

    val_stats = None
    if args.style_set in ("val", "both"):
        val_stats = generate_val(out_path=DATA_DIR / "cells_val.h5")

    write_manifest(train_stats, val_stats)
    return 0


if __name__ == "__main__":
    sys.exit(main())
