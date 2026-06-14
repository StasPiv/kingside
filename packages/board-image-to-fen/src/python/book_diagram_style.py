"""KS-3110 follow-up: book-diagram стиль для find-pieces (v4).

Стиль печатных шахматных диаграмм (Chess Informant, Encyclopaedia of Chess
Endings, советские учебники Майзелиса/Калиниченко): тёмные клетки
заштрихованы диагональными линиями на белом фоне, фигуры нарисованы
**контурно для белых** и **силуэтом для чёрных**.

Это out-of-distribution для текущей v4 модели (train_styles содержит
только lichess-палитры с залитыми фигурами). На фото из книги
(/tmp/examples-board-recog/photo_2026-05-19_14-26-24.jpg) модель ошибается
именно в цвете: белый король с тонким контуром интерпретируется как
чёрный, потому что «тёмные линии на светлом фоне» в трейне ассоциированы
с чёрными фигурами.

Добавление этого стиля в TRAIN_STYLES закрывает книжный кейс без
изменения архитектуры модели.

API:

    from book_diagram_style import (
        render_book_board_background,   # фон доски 512×512
        render_book_piece,              # фигура 64×64 RGBA
    )
"""

from __future__ import annotations

import math
import random
from typing import Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Локально-локальный импорт: процедурный рендерер фигур (lichess-style),
# результаты которого мы постпроцессим до book-style.
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from procedural_pieces import render_procedural_piece

CELL = 64
BOARD = CELL * 8  # 512×512


# ─── Фон: book-style клетки ──────────────────────────────────────────────

def _draw_hatch_cell(rng: random.Random, dark: bool = True) -> Image.Image:
    """Одна клетка 64×64.

    `dark=True` — клетка с диагональной штриховкой (тёмная по семантике,
    хотя сами штрихи на белом фоне).
    `dark=False` — почти чисто-белая клетка с лёгкой шероховатостью
    (имитация бумаги/печати).
    """
    if not dark:
        # Светлая клетка: белый фон с лёгким сероватым шумом (иначе модель
        # выучит «pixel == 255,255,255 → light», что хрупко).
        base_v = rng.randint(245, 255)
        cell = Image.new("RGB", (CELL, CELL), (base_v, base_v, base_v - rng.randint(0, 3)))
        # Лёгкий шум — мелкие точки 5% пикселей сероватого.
        if rng.random() < 0.6:
            arr = np.array(cell)
            n_noise = rng.randint(50, 200)
            ys = np.random.randint(0, CELL, size=n_noise)
            xs = np.random.randint(0, CELL, size=n_noise)
            arr[ys, xs] = arr[ys, xs] - rng.randint(8, 25)
            arr = np.clip(arr, 0, 255).astype(np.uint8)
            cell = Image.fromarray(arr)
        return cell

    # Тёмная клетка: белый фон + диагональная штриховка.
    base_v = rng.randint(248, 255)
    cell = Image.new("RGB", (CELL, CELL), (base_v, base_v, base_v))
    draw = ImageDraw.Draw(cell)

    # Параметры штриха.
    angle_deg = rng.choice([45, 45, 45, -45, -45, 135, 30, 60])     # чаще классические 45°
    spacing = rng.randint(3, 6)                                       # шаг между линиями
    stroke_w = rng.choice([1, 1, 1, 2])                               # тонкие линии
    ink_v = rng.randint(40, 110)
    ink = (ink_v, ink_v, ink_v)

    # Рисуем серию параллельных линий через клетку.
    angle_rad = math.radians(angle_deg)
    cos_a = math.cos(angle_rad)
    sin_a = math.sin(angle_rad)
    # Идём перпендикулярно направлению штриха с шагом spacing.
    perp_x = -sin_a
    perp_y = cos_a
    # Диапазон смещений — покрываем всю клетку.
    diag = int(math.sqrt(2) * CELL) + 4
    cx, cy = CELL / 2, CELL / 2
    n = diag // spacing
    for i in range(-n, n + 1):
        d = i * spacing
        # Точка на перпендикуляре от центра.
        px = cx + perp_x * d
        py = cy + perp_y * d
        # Линия через эту точку в направлении (cos_a, sin_a), длинная.
        x0 = px - cos_a * diag
        y0 = py - sin_a * diag
        x1 = px + cos_a * diag
        y1 = py + sin_a * diag
        draw.line([(x0, y0), (x1, y1)], fill=ink, width=stroke_w)

    # Иногда — кросс-штриховка (двойная решётка) у части клеток.
    if rng.random() < 0.15:
        angle_rad2 = math.radians(angle_deg + 90)
        cos_b = math.cos(angle_rad2)
        sin_b = math.sin(angle_rad2)
        perp_x2 = -sin_b
        perp_y2 = cos_b
        for i in range(-n, n + 1):
            d = i * spacing
            px = cx + perp_x2 * d
            py = cy + perp_y2 * d
            x0 = px - cos_b * diag
            y0 = py - sin_b * diag
            x1 = px + cos_b * diag
            y1 = py + sin_b * diag
            draw.line([(x0, y0), (x1, y1)], fill=ink, width=stroke_w)

    return cell


def render_book_board_background(rng: random.Random) -> Image.Image:
    """Фон доски 8×8 в book-style: a1 (низ-лево) — тёмная (штрихованная).

    Параметры штриха выбираются единообразно на всю доску (одна доска —
    один стиль штриховки), чтобы не дать модели «зацепиться» за
    варьирующийся штрих как cue к классу клетки.
    """
    # Зафиксируем seed штриха для всей доски (одна штриховка везде).
    style_seed = rng.randint(0, 2**31)
    style_rng = random.Random(style_seed)
    # Заранее рендерим эталонную тёмную клетку и используем её ВСЕ тёмные.
    dark_cell_template = _draw_hatch_cell(style_rng, dark=True)
    light_cell_template = _draw_hatch_cell(style_rng, dark=False)

    board = Image.new("RGB", (BOARD, BOARD), (255, 255, 255))
    for r in range(8):
        for c in range(8):
            rank_from_a1 = 7 - r
            is_light = (c + rank_from_a1) % 2 == 1
            cell = light_cell_template if is_light else dark_cell_template
            # Чтобы не была идентичная копия одна-в-одну (модель выучит pattern),
            # в 30% клеток применим лёгкое случайное возмущение яркости.
            if rng.random() < 0.3:
                arr = np.array(cell).astype(np.int16)
                delta = rng.randint(-10, 10)
                arr = np.clip(arr + delta, 0, 255).astype(np.uint8)
                cell_v = Image.fromarray(arr)
            else:
                cell_v = cell
            board.paste(cell_v, (c * CELL, r * CELL))
    return board


# ─── Фигуры: outline-белые, filled-чёрные ────────────────────────────────

def _erode_mask(mask: np.ndarray, iterations: int) -> np.ndarray:
    """Эрозия булевой маски на `iterations` пикселей (PIL MinFilter)."""
    if iterations <= 0:
        return mask.copy()
    img = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
    for _ in range(iterations):
        img = img.filter(ImageFilter.MinFilter(3))
    return np.array(img) > 128


def render_book_piece(label: str, rng: random.Random) -> Image.Image:
    """Фигура 64×64 RGBA в book-стиле.

    - Белая (label='w*'): почти-белая заливка + тонкий тёмный stroke.
      Поскольку рендер выполняется ПРЯМО через procedural_pieces.draw_*
      с пробросом book_style=True (а не через постпроцессинг маски),
      ВСЕ внутренние детали корпуса фигуры — шарики короны ферзя,
      полосы юбки, крест короля, поперечная щель слона — рисуются
      явно через stroke, и видны на конечном изображении. Это критично
      для распознавания: модель должна различать класс по форме короны/
      деталей, а не по «толщине outline».
    - Чёрная (label='b*'): почти-чёрная заливка + чёрный stroke того же
      цвета (внутренние линии не видны) — сплошной силуэт.

    История: в первой итерации использовался постпроцессинг маски
    (erode → outline + inner), но он терял внутренние детали ферзя/
    короля — белый ферзь становился «толстым контуром» без короны и
    путался с чёрным. Прямой проброс book_style в SVG/PIL рендер
    сохраняет всю исходную графику.
    """
    if len(label) != 2 or label[0] not in "wb":
        raise ValueError(f"bad label: {label!r}")
    img = render_procedural_piece(label, rng, book_style=True)

    # Опциональный лёгкий blur 20% случаев — имитация сканированной
    # книжной диаграммы.
    if rng.random() < 0.20:
        img = img.filter(ImageFilter.GaussianBlur(radius=rng.uniform(0.3, 0.6)))
    return img
