#!/usr/bin/env python3
"""KS-3110: генератор датасета find-boards для YOLO.

Один класс — `board`. На каждом сгенерированном «скриншоте» 1..N досок
встроены в случайный визуальный контекст (текст, кнопки, иконки,
крупные шахматные графики как negative samples). YOLO учится выделять
доску bbox'ом независимо от обрамления.

Pipeline (production):
    image → find-boards YOLO → массив bbox каждой доски → для каждого
    bbox → crop → find-pieces YOLO (v2.0.0) → FEN.

Каждая «доска» внутри скриншота сама генерируется через
`board_dataset_gen.render_board_with_annotations()` — это значит мы
переиспользуем тот же набор стилей фигур и фонов.

Аннотации в YOLO-формате:
    /out_dir/
        images/train/scene_NNNNNN.png
        labels/train/scene_NNNNNN.txt    # «0 cx cy w h\\n» на каждую доску
        images/val/...
        labels/val/...
        dataset.yaml
        manifest.json
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw, ImageFont, ImageFilter

# Локальные модули — переиспользуем рендерер досок.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from board_dataset_gen import render_board_with_annotations, BOARD_SIZE
from dataset_gen import (
    TRAIN_STYLES,
    VAL_STYLES,
    _build_val_fen_list,
    _collect_random_fens,
)


# ─── Configuration ────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "data" / "v5-findboards"

# Размеры canvas (имитация типичного скриншота).
CANVAS_SIZES: List[Tuple[int, int]] = [
    (1200, 800),
    (1400, 900),
    (1024, 768),
    (1920, 1080),
    (768, 1024),    # mobile portrait
    (980, 600),     # шире-короткий (lichess analyse)
]

# Доска в скриншоте уменьшается с BOARD_SIZE=512 до случайного размера.
MIN_BOARD_PX = 180
MAX_BOARD_PX = 700

# Сколько досок на одной сцене.
N_BOARDS_DIST: List[Tuple[int, float]] = [
    (1, 0.55),    # 55% — один кадр одной доски (типовой случай user grab)
    (2, 0.18),
    (3, 0.10),
    (4, 0.08),
    (6, 0.05),
    (8, 0.04),    # типа страница пазлов 4×2
]

# Фоновая палитра canvas.
BG_PALETTES: List[Tuple[int, int, int]] = [
    (255, 255, 255),    # белый — учебники, документы
    (245, 245, 245),    # светло-серый — kingside.site, chess.com analyse
    (252, 247, 230),    # бежевый — учебники Калиниченко
    (230, 234, 240),    # светло-голубой
    (28, 30, 36),       # тёмный — dark mode UI
    (40, 44, 52),       # тёмный 2
    (10, 49, 26),       # зелёный фон lichess
]


# ─── Контекст-рисователи ──────────────────────────────────────────────

def _font_or_default(size: int):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _is_dark(rgb: Tuple[int, int, int]) -> bool:
    r, g, b = rgb
    return 0.299 * r + 0.587 * g + 0.114 * b < 110


def _draw_text_block(
    canvas: Image.Image, x: int, y: int, w: int, h: int,
    rng: random.Random, bg_dark: bool,
) -> None:
    """Рандомный текст-параграф в прямоугольнике (x,y,w,h)."""
    draw = ImageDraw.Draw(canvas)
    font_sz = rng.randint(10, 18)
    font = _font_or_default(font_sz)
    line_h = font_sz + 4
    n_lines = max(1, h // line_h)
    color = (220, 220, 220) if bg_dark else (40, 44, 52)
    # Случайные «строки» — слова разной длины.
    LOREM_WORDS = [
        "Karpov", "Carlsen", "Stockfish", "1.e4", "e5", "Nf3",
        "Nc6", "Bb5", "a6", "blunder", "tactic", "endgame",
        "checkmate", "fork", "pin", "skewer", "queen", "king",
        "rook", "bishop", "knight", "pawn", "diagram", "white",
        "black", "move", "best", "analysis", "study", "puzzle",
        "12.", "Nxd5", "Qxd5", "Bxd5", "draw", "advantage",
    ]
    for i in range(n_lines):
        if rng.random() < 0.1:
            continue   # пустая строка (пропуск параграфа)
        words = []
        line_w_used = 0
        while line_w_used < w - 20:
            word = rng.choice(LOREM_WORDS)
            bbox = font.getbbox(word + " ")
            ww = bbox[2] - bbox[0]
            if line_w_used + ww > w - 6:
                break
            words.append(word)
            line_w_used += ww + 3
        text = " ".join(words)
        draw.text((x + 4, y + i * line_h), text, fill=color, font=font)


def _draw_ui_buttons(
    canvas: Image.Image, x: int, y: int, w: int, h: int,
    rng: random.Random,
) -> None:
    """Серия «кнопок» / icon-grid'ов вверху/сбоку, как у lichess/chess.com."""
    draw = ImageDraw.Draw(canvas)
    row_h = rng.randint(24, 36)
    cur_y = y
    while cur_y + row_h < y + h:
        n = rng.randint(2, 6)
        slot_w = w // n
        for i in range(n):
            bx0 = x + i * slot_w + 4
            bx1 = bx0 + slot_w - 8
            by0 = cur_y + 2
            by1 = cur_y + row_h - 2
            r = rng.randint(40, 220)
            g = rng.randint(40, 220)
            b = rng.randint(40, 220)
            draw.rounded_rectangle(
                [bx0, by0, bx1, by1],
                radius=rng.randint(2, 8),
                fill=(r, g, b),
                outline=None,
            )
        cur_y += row_h + 4


def _draw_chess_silhouette_distractor(
    canvas: Image.Image, x: int, y: int, w: int, h: int,
    rng: random.Random,
) -> None:
    """Крупный одиночный силуэт фигуры — имитация рекламы / иконки
    логотипа сайта. Negative sample: на нём детектор НЕ должен
    выделять bbox (это не доска)."""
    from procedural_pieces import render_procedural_piece
    piece_label = rng.choice(["wK", "bK", "wQ", "bQ", "wN", "bN"])
    piece = render_procedural_piece(piece_label, rng)
    # Растягиваем silhouette на крупный rect (200..500 px).
    side = min(w, h) - 20
    if side < 100:
        return
    side = min(side, 500)
    piece = piece.resize((side, side), Image.LANCZOS)
    canvas.paste(piece, (x + (w - side) // 2, y + (h - side) // 2), piece)


# ─── Layout одной сцены ───────────────────────────────────────────────

def _sample_n_boards(rng: random.Random) -> int:
    pick = rng.random()
    cum = 0.0
    for n, w in N_BOARDS_DIST:
        cum += w
        if pick < cum:
            return n
    return N_BOARDS_DIST[-1][0]


def _layout_boards(
    canvas_w: int, canvas_h: int, n_boards: int, rng: random.Random,
) -> List[Tuple[int, int, int]]:
    """Сгенерировать список позиций (x, y, size) для досок на canvas.

    Чтобы не пересекались — пробуем 200 раз. Если не получилось — берём
    меньшее количество.
    """
    positions: List[Tuple[int, int, int]] = []
    tries = 0
    while len(positions) < n_boards and tries < 200:
        tries += 1
        # Размер доски сжимается если их много.
        max_side = min(canvas_w, canvas_h) - 40
        size_cap = MIN_BOARD_PX + int((MAX_BOARD_PX - MIN_BOARD_PX) * (1 / max(1, n_boards ** 0.5)))
        size = rng.randint(MIN_BOARD_PX, min(MAX_BOARD_PX, max_side, size_cap))
        x = rng.randint(10, max(11, canvas_w - size - 10))
        y = rng.randint(10, max(11, canvas_h - size - 10))
        # Проверяем непересечение.
        overlap = any(
            not (x + size <= px or px + ps <= x or y + size <= py or py + ps <= y)
            for px, py, ps in positions
        )
        if not overlap:
            positions.append((x, y, size))
    return positions


# ─── Генерация одной сцены ────────────────────────────────────────────

def _render_one_scene(
    fens_pool: List[str],
    styles: List[str],
    rng: random.Random,
    procedural_bg: bool = True,
    add_distractor_prob: float = 0.15,
) -> Tuple[Image.Image, List[Tuple[float, float, float, float]]]:
    """Сгенерировать одну сцену + список bbox досок (xyxy, в пикселях canvas)."""
    canvas_size = rng.choice(CANVAS_SIZES)
    canvas_w, canvas_h = canvas_size
    bg = rng.choice(BG_PALETTES)
    bg_dark = _is_dark(bg)
    canvas = Image.new("RGB", (canvas_w, canvas_h), bg)

    # Контекстный шум — параграф текста, UI-кнопки.
    if rng.random() < 0.6:
        # текст-параграф где-то с одной стороны
        tx = 10 if rng.random() < 0.5 else canvas_w // 2
        tw = rng.randint(200, canvas_w // 2 - 20)
        ty = rng.randint(10, max(11, canvas_h - 150))
        th = rng.randint(100, max(101, canvas_h - ty - 10))
        _draw_text_block(canvas, tx, ty, tw, th, rng, bg_dark)
    if rng.random() < 0.4:
        # ряд кнопок-фильтров сверху
        _draw_ui_buttons(canvas, 5, 5, canvas_w - 10, 60, rng)

    # Доски.
    n_boards = _sample_n_boards(rng)
    positions = _layout_boards(canvas_w, canvas_h, n_boards, rng)
    bboxes: List[Tuple[float, float, float, float]] = []
    for (x, y, size) in positions:
        fen = rng.choice(fens_pool)
        style = rng.choice(styles)
        board_img, _piece_anns = render_board_with_annotations(
            fen, style, rng, procedural_bg=procedural_bg,
        )
        board_resized = board_img.resize((size, size), Image.LANCZOS)
        canvas.paste(board_resized, (x, y))
        bboxes.append((float(x), float(y), float(x + size), float(y + size)))

    # Distractor — крупная одиночная фигура в свободном углу (negative
    # sample для проверки что детектор не путает гигантский silhouette
    # с доской).
    if rng.random() < add_distractor_prob and len(positions) < 4:
        # выбираем зону подальше от существующих досок
        dx, dy = rng.randint(10, canvas_w - 250), rng.randint(10, canvas_h - 250)
        ds = rng.randint(150, 350)
        # проверка непересечения (грубая)
        if not any(
            not (dx + ds <= px or px + ps <= dx or dy + ds <= py or py + ps <= dy)
            for px, py, ps in positions
        ):
            _draw_chess_silhouette_distractor(canvas, dx, dy, ds, ds, rng)

    # Финальный лёгкий blur 10% — имитация скриншот-сжатия.
    if rng.random() < 0.1:
        canvas = canvas.filter(ImageFilter.GaussianBlur(radius=rng.uniform(0.3, 0.8)))
    return canvas, bboxes


def encode_yolo_line(bbox: Tuple[float, float, float, float],
                     img_w: int, img_h: int) -> str:
    x0, y0, x1, y1 = bbox
    cx = (x0 + x1) / 2 / img_w
    cy = (y0 + y1) / 2 / img_h
    w = (x1 - x0) / img_w
    h = (y1 - y0) / img_h
    return f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}"


def generate_split(
    n_scenes: int,
    fens_pool: List[str],
    styles: List[str],
    out_images_dir: Path,
    out_labels_dir: Path,
    seed: int,
    procedural_bg: bool,
    prefix: str,
) -> Dict[str, int]:
    out_images_dir.mkdir(parents=True, exist_ok=True)
    out_labels_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    print(f"[{prefix}] generating {n_scenes} scenes → {out_images_dir.parent}",
          file=sys.stderr)
    t0 = time.time()
    total_boards = 0
    for i in range(n_scenes):
        canvas, bboxes = _render_one_scene(
            fens_pool, styles, rng, procedural_bg=procedural_bg,
        )
        img_path = out_images_dir / f"{prefix}_{i:06d}.png"
        lbl_path = out_labels_dir / f"{prefix}_{i:06d}.txt"
        canvas.save(img_path, format="PNG")
        with lbl_path.open("w") as fh:
            for bb in bboxes:
                fh.write(encode_yolo_line(bb, canvas.size[0], canvas.size[1]) + "\n")
        total_boards += len(bboxes)
        if (i + 1) % 50 == 0 or i + 1 == n_scenes:
            el = time.time() - t0
            rate = (i + 1) / max(el, 0.01)
            eta = (n_scenes - i - 1) / max(rate, 0.01)
            print(f"[{prefix}] {i+1}/{n_scenes} ({rate:.1f}/s, ETA {eta:.0f}s, "
                  f"boards={total_boards})",
                  file=sys.stderr)
    return {"n_scenes": n_scenes, "n_boards_total": total_boards}


def write_dataset_yaml(out_dir: Path) -> None:
    cfg = (
        f"path: {out_dir.resolve()}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"nc: 1\n"
        f"names: ['board']\n"
    )
    (out_dir / "dataset.yaml").write_text(cfg)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--n-train-scenes", type=int, default=1500)
    ap.add_argument("--n-val-scenes", type=int, default=100)
    ap.add_argument("--n-train-fens", type=int, default=80,
                    help="Сколько уникальных FEN-позиций перемешивать "
                         "по сценам train. Меньше = быстрее генерация.")
    ap.add_argument("--max-train-styles", type=int, default=10)
    ap.add_argument("--no-procedural-bg", action="store_true")
    ap.add_argument("--seed", type=int, default=3110)
    args = ap.parse_args(argv)

    procedural_bg = not args.no_procedural_bg
    train_styles = TRAIN_STYLES[: args.max_train_styles]
    val_styles = VAL_STYLES

    print(f"[plan] train_styles ({len(train_styles)}): {train_styles}", file=sys.stderr)
    print(f"[plan] val_styles   ({len(val_styles)}): {val_styles}", file=sys.stderr)
    print(f"[plan] procedural_bg={procedural_bg}", file=sys.stderr)

    train_fens = _collect_random_fens(args.n_train_fens, seed=args.seed)
    val_fens_all, _ = _build_val_fen_list()
    val_fens = val_fens_all[:30]

    out = args.out_dir
    out.mkdir(parents=True, exist_ok=True)

    train_stats = generate_split(
        n_scenes=args.n_train_scenes,
        fens_pool=train_fens,
        styles=train_styles,
        out_images_dir=out / "images" / "train",
        out_labels_dir=out / "labels" / "train",
        seed=args.seed + 1,
        procedural_bg=procedural_bg,
        prefix="train",
    )
    val_stats = generate_split(
        n_scenes=args.n_val_scenes,
        fens_pool=val_fens,
        styles=val_styles,
        out_images_dir=out / "images" / "val",
        out_labels_dir=out / "labels" / "val",
        seed=args.seed + 2,
        procedural_bg=False,   # val без procedural-bg — стабильная метрика
        prefix="val",
    )

    write_dataset_yaml(out)
    manifest = {
        "task": "KS-3110 find-boards (board detection only)",
        "n_classes": 1,
        "classes": ["board"],
        "canvas_sizes": CANVAS_SIZES,
        "n_boards_per_scene_distribution": N_BOARDS_DIST,
        "train_styles": train_styles,
        "val_styles": val_styles,
        "train": train_stats,
        "val": val_stats,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"[done] manifest at {out / 'manifest.json'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
