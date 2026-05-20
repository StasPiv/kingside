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
from book_diagram_style import render_book_board_background, render_book_piece
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

# KS-3155: процедурное рисование фигур (procedural_book) возвращено
# в обучающую выборку — после переработки анатомии пешки (круглое
# тело-шар + полукруглая юбка-колокол) и слона (овальная митра с
# шариком-фиалом + диагональный разрез). См. procedural_pieces.py
# (draw_pawn/draw_bishop). Прежняя версия KS-3091 страдала путаницей
# силуэтов пешки и слона, что и привело к её удалению в KS-3142.
#
# Стиль активируется sentinel'ом `BOOK_STYLE` — когда `style` равен
# этой строке, и фон, и фигуры рендерятся через book_diagram_style.*
# (а не через `_load_piece` из настоящего piece-set'а). Это
# дополнительная аугментация для распознавания книжных диаграмм
# (Chess Informant / советские учебники).
BOOK_STYLE = "procedural_book"

# Downscale-blur аугментация: ~30% досок после рендеринга проходят через
# downscale до 80-256 px и upscale обратно до 512×512. Это имитирует
# кейс multi-board сетки (например, kingside.io grid из 12 досок-карточек
# ~195 px каждая), где find-boards обрезает мелкую исходную доску и
# отдаёт её find-pieces, который ресайзит обратно до 512×512. Без этой
# аугментации модель видит только «крупные» фигуры; после resize
# из мелкого источника фигуры размываются, контур белых «утолщается»
# интерполяцией, и они путаются с чёрными.
DOWNSCALE_AUG_PROB = 0.30
DOWNSCALE_MIN_SIZE = 80
DOWNSCALE_MAX_SIZE = 256

# Camera-аугментация: ослабленная относительно v4-v5. В v4-v5 при 0.25 +
# агрессивных компонентах (perspective ±6%, glow, lighting 0.7-1.3) модель
# стала «над-консервативной» — терялся порог confidence на чётких фигурах,
# фигуры начали пропускаться на обычных скриншотах. v4-v6: вероятность
# понижена до 0.10, perspective и glow отключены (слишком сильно искажали
# геометрию и яркость), оставлены только мягкий lighting gradient (0.85-
# 1.15), gaussian noise (sigma 2-5) и JPEG (quality 75-90).
CAMERA_AUG_PROB = 0.10


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
    (class_idx, bbox) — bbox в пикселях изображения (x0, y0, x1, y1).

    KS-3155: если `style == BOOK_STYLE`, фигуры рендерятся процедурно
    через `render_book_piece` (book_diagram_style.py) — каждая фигура
    уникальна и нарисована из примитивов в стиле печатных диаграмм.
    Для всех остальных стилей — обычная загрузка спрайта.
    """
    annotations: List[Tuple[int, Tuple[float, float, float, float]]] = []
    for r, row in enumerate(grid):
        for c, label in enumerate(row):
            if label == "empty":
                continue
            if style == BOOK_STYLE:
                piece_img = render_book_piece(label, rng)
            else:
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


def _maybe_apply_downscale_blur(board: Image.Image, rng: random.Random) -> Image.Image:
    """С DOWNSCALE_AUG_PROB вероятностью даунскейлит доску до 80-256 px и
    апскейлит обратно до BOARD_SIZE. Имитирует фигуры после find-boards
    crop из маленькой исходной доски (multi-board grid kingside.io и т. п.)."""
    if rng.random() >= DOWNSCALE_AUG_PROB:
        return board
    target = rng.randint(DOWNSCALE_MIN_SIZE, DOWNSCALE_MAX_SIZE)
    # Разные фильтры — модель не должна цепляться за конкретный тип
    # интерполяционных артефактов.
    down_filter = rng.choice([Image.BILINEAR, Image.LANCZOS, Image.BOX, Image.BICUBIC])
    up_filter = rng.choice([Image.BILINEAR, Image.LANCZOS, Image.NEAREST, Image.BICUBIC])
    small = board.resize((target, target), down_filter)
    big = small.resize((BOARD_SIZE, BOARD_SIZE), up_filter)
    # 30% случаев — лёгкое JPEG-сжатие поверх (имитация веб-картинок,
    # которые часто перепакованы в JPEG).
    if rng.random() < 0.30:
        import io as _io
        buf = _io.BytesIO()
        big.save(buf, format="JPEG", quality=rng.randint(60, 92))
        buf.seek(0)
        big = Image.open(buf).convert("RGB")
    return big


def _maybe_apply_camera_aug(board: Image.Image, rng: random.Random) -> Image.Image:
    """С CAMERA_AUG_PROB вероятностью имитирует фото на камеру: мягкая
    неравномерная подсветка, лёгкий шум, JPEG. Перспектива и blic
    отключены (вызывали регрессию в v4-v5 — модель становилась слишком
    консервативной и пропускала фигуры на чётких изображениях).
    """
    if rng.random() >= CAMERA_AUG_PROB:
        return board

    import numpy as np

    # 1. Мягкий lighting gradient (0.85..1.15 вместо 0.7..1.3 у v4-v5).
    if rng.random() < 0.5:
        arr = np.array(board).astype(np.float32)
        h_arr, w_arr = arr.shape[:2]
        angle = rng.uniform(0, 2 * 3.14159)
        gx = np.cos(angle)
        gy = np.sin(angle)
        ys, xs = np.mgrid[0:h_arr, 0:w_arr]
        proj = (xs * gx + ys * gy)
        proj = (proj - proj.min()) / (proj.max() - proj.min() + 1e-6)
        v_min = rng.uniform(0.85, 0.95)
        v_max = rng.uniform(1.05, 1.15)
        scale = v_min + proj * (v_max - v_min)
        arr = arr * scale[:, :, None]
        arr = np.clip(arr, 0, 255).astype(np.uint8)
        board = Image.fromarray(arr, "RGB")

    # 2. Лёгкий gaussian noise (sigma 2-5 вместо 2-8 у v4-v5).
    if rng.random() < 0.5:
        arr = np.array(board).astype(np.float32)
        sigma = rng.uniform(2, 5)
        noise = np.random.normal(0, sigma, arr.shape)
        arr = arr + noise
        arr = np.clip(arr, 0, 255).astype(np.uint8)
        board = Image.fromarray(arr, "RGB")

    # 3. JPEG-сжатие повышенного качества (75-90 вместо 50-85 у v4-v5).
    if rng.random() < 0.6:
        import io as _io
        buf = _io.BytesIO()
        board.save(buf, format="JPEG", quality=rng.randint(75, 90))
        buf.seek(0)
        board = Image.open(buf).convert("RGB")

    return board


def render_board_with_annotations(
    fen: str,
    style: str,
    rng: random.Random,
    procedural_bg: bool = True,
    book_bg: bool = False,
) -> Tuple[Image.Image, List[Tuple[int, Tuple[float, float, float, float]]]]:
    """Сгенерировать одну доску + bbox-аннотации.

    Возвращает (PIL.Image RGB BOARD_SIZE×BOARD_SIZE, [(class_idx, (x0,y0,x1,y1)), ...]).

    KS-3142: «книжный режим» переписан. Раньше sentinel `BOOK_STYLE`
    рендерил доску целиком в book-стиле — фон штрих + фигуры через
    `procedural_pieces` (одинаковые силуэты для пешки/слона рисовали
    плохо и были не похожи на учебниковые). Теперь параметр `book_bg`
    включает **только книжный фон**, а фигуры берутся из обычного
    piece-set'а (`style` остаётся обычным lichess-стилем). Это даёт
    реалистичные фигуры на печатном фоне.

    Аугментация downscale-blur применяется в обоих режимах — для
    multi-board кейса (фигура из маленькой доски-карточки).
    """
    grid = _fen_to_grid(fen)
    # KS-3155: для BOOK_STYLE (процедурные книжные фигуры) фон ВСЕГДА
    # книжный — иначе процедурные силуэты на бежевой подложке выглядят
    # как мусор и сбивают модель.
    if style == BOOK_STYLE:
        book_bg = True
    if book_bg:
        board = render_book_board_background(rng)
    else:
        board = _render_board_background(rng, procedural=procedural_bg)
    anns = _place_pieces(board, grid, style, rng)
    if book_bg:
        # У книжного фона штриховка уже разделяет клетки; явные grid-lines
        # рисуем редко (5%) — реальные диаграммы их обычно не имеют.
        if rng.random() < 0.05:
            _maybe_draw_grid_lines(board, rng)
        board = _maybe_apply_downscale_blur(board, rng)
        board = _maybe_apply_camera_aug(board, rng)
    else:
        _maybe_draw_grid_lines(board, rng)
        board = _maybe_apply_downscale_blur(board, rng)
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
    book_bg_share: float = 0.0,
    procedural_book_share: float = 0.0,
) -> Dict[str, int]:
    """Сгенерировать одну сплит-выборку — каждую (FEN × style) → один файл.

    KS-3142: `book_bg_share` (0..1) — какая доля досок отрендерится на
    книжном фоне (штрихованные тёмные клетки) вместо обычной шашечной
    подложки. Фигуры в этом режиме берутся из настоящего piece-set'а.

    KS-3155: `procedural_book_share` (0..1) — какая доля досок будет
    отрендерена с процедурными книжными фигурами (через
    book_diagram_style.render_book_piece) поверх книжного фона. Эта
    выборка ОТНИМАЕТСЯ из общего числа, а не добавляется поверх:
    сначала с вероятностью `procedural_book_share` выбирается
    sentinel-стиль BOOK_STYLE, иначе — обычный piece-set из `styles`.
    `book_bg_share` действует на оставшуюся часть.
    """
    out_images_dir.mkdir(parents=True, exist_ok=True)
    out_labels_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    n_total = len(fens) * len(styles)
    print(
        f"[{prefix}] generating {n_total} boards ({len(fens)} FEN × {len(styles)} styles) "
        f"book_bg_share={book_bg_share:.2f} "
        f"procedural_book_share={procedural_book_share:.2f} "
        f"→ {out_images_dir.parent}",
        file=sys.stderr,
    )
    t0 = time.time()
    class_counts: Dict[int, int] = {i: 0 for i in range(len(CLASS_NAMES))}
    n_book = 0
    n_proc = 0
    idx = 0
    for fen in fens:
        for style in styles:
            use_procedural = (
                procedural_book_share > 0
                and rng.random() < procedural_book_share
            )
            if use_procedural:
                eff_style = BOOK_STYLE
                use_book = True
                n_proc += 1
            else:
                eff_style = style
                use_book = book_bg_share > 0 and rng.random() < book_bg_share
            if use_book:
                n_book += 1
            board, anns = render_board_with_annotations(
                fen, eff_style, rng,
                procedural_bg=procedural_bg,
                book_bg=use_book,
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
        "n_book_bg": n_book,
        "n_procedural_book": n_proc,
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
    ap.add_argument(
        "--book-bg-share", type=float, default=0.25,
        help="KS-3142: доля train-досок, отрендеренных на книжном "
             "(штрихованном) фоне с обычными piece-set'ами поверх. "
             "Default 0.25. Заменяет прежний BOOK_STYLE sentinel "
             "(который рендерил procedural-фигуры и плохо работал).",
    )
    ap.add_argument(
        "--book-bg-share-val", type=float, default=0.1,
        help="То же для val-сплита. Меньше чем train, чтобы основная "
             "метрика mAP считалась на обычных досках.",
    )
    ap.add_argument(
        "--procedural-book-share", type=float, default=0.10,
        help="KS-3155: доля train-досок с процедурными книжными "
             "фигурами (book_diagram_style.render_book_piece) поверх "
             "книжного фона. Аугментация для распознавания учебниковых "
             "диаграмм. Default 0.10.",
    )
    ap.add_argument(
        "--procedural-book-share-val", type=float, default=0.05,
        help="То же для val. Маленький, чтобы основная mAP считалась "
             "на обычных piece-set'ах.",
    )
    args = ap.parse_args(argv)

    procedural_bg = not args.no_procedural_bg
    train_styles = TRAIN_STYLES[: args.max_train_styles]
    val_styles = VAL_STYLES

    print(f"[plan] train_styles ({len(train_styles)}): {train_styles}", file=sys.stderr)
    print(f"[plan] val_styles   ({len(val_styles)}): {val_styles}", file=sys.stderr)
    print(f"[plan] procedural_bg={procedural_bg} "
          f"book_bg_share train={args.book_bg_share} val={args.book_bg_share_val} "
          f"procedural_book_share train={args.procedural_book_share} "
          f"val={args.procedural_book_share_val}",
          file=sys.stderr)

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
        book_bg_share=args.book_bg_share,
        procedural_book_share=args.procedural_book_share,
    )
    val_stats = generate_split(
        fens=val_fens,
        styles=val_styles,
        out_images_dir=out / "images" / "val",
        out_labels_dir=out / "labels" / "val",
        seed=args.seed + 200,
        procedural_bg=False,  # val всегда чистый, для воспроизводимой метрики
        prefix="val",
        book_bg_share=args.book_bg_share_val,
        procedural_book_share=args.procedural_book_share_val,
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
        "book_bg": {
            "enabled": args.book_bg_share > 0 or args.book_bg_share_val > 0,
            "train_share": args.book_bg_share,
            "val_share": args.book_bg_share_val,
            "note": (
                "KS-3142: книжный фон (штриховка) + обычные piece-set'ы. "
                "Прежний BOOK_STYLE с procedural-фигурами убран — он плохо "
                "различал силуэты пешки и слона."
            ),
        },
        "procedural_book": {
            "enabled": (args.procedural_book_share > 0
                        or args.procedural_book_share_val > 0),
            "train_share": args.procedural_book_share,
            "val_share": args.procedural_book_share_val,
            "note": (
                "KS-3155: процедурные книжные фигуры возвращены в "
                "обучающую выборку после переработки анатомии пешки "
                "(круглое тело + полукруглая юбка) и слона (овальная "
                "митра с шариком + диагональный разрез). Sentinel-стиль "
                "BOOK_STYLE — фон и фигуры рендерятся через "
                "book_diagram_style.* (а не через _load_piece). Делает "
                "модель устойчивее к учебниковым диаграммам."
            ),
        },
        "downscale_aug": {
            "enabled": True,
            "probability": DOWNSCALE_AUG_PROB,
            "size_range_px": [DOWNSCALE_MIN_SIZE, DOWNSCALE_MAX_SIZE],
            "note": (
                "Аугментация для multi-board кейса (например, kingside.io "
                "grid из 12 досок ~195 px). Доска 512×512 даунскейлится до "
                "80-256 px и апскейлится обратно — имитирует find-boards "
                "crop из мелкой исходной доски с интерполяционным "
                "размытием. Покрывает кейс /tmp/examples-board-recog/"
                "multiple-boards-kingside.png (систематическая путаница "
                "цвета ферзей после resize мелких досок)."
            ),
        },
        "camera_aug": {
            "enabled": True,
            "probability": CAMERA_AUG_PROB,
            "components": [
                "lighting_gradient (0.85..1.15 яркости направленно)",
                "gaussian_noise (sigma 2-5)",
                "jpeg_compression (quality 75-90)",
            ],
            "removed_in_v6": [
                "perspective_warp (искажал геометрию, фигуры съезжали по клеткам)",
                "local_glow (полностью гасил фигуры в области блика)",
            ],
            "note": (
                "Аугментация для фото на камеру — лёгкие имитации шума/"
                "JPEG/подсветки. Изначально в v4-v5 была более агрессивной "
                "(perspective + glow + lighting 0.7-1.3), но это сделало "
                "модель over-conservative — она стала пропускать фигуры "
                "даже на чётких изображениях. В v4-v6 ослаблена: "
                "perspective и glow удалены, вероятности и интенсивности "
                "снижены, общая вероятность 0.10 (было 0.25)."
            ),
        },
        "train": train_stats,
        "val": val_stats,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"[done] wrote {out / 'manifest.json'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
