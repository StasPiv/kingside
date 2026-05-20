"""KS-3091 follow-up. Procedural chess piece generator (ADR-040-v2 vendor B1).

Вместо использования готовых piece-sets рисуем фигуры программно из
геометрических примитивов (эллипсы, прямоугольники, полилинии) с
рандомизированными параметрами.

Цель: расширить train разнообразием силуэтов **бесконечно**, чтобы модель
научилась распознавать «класс фигуры», а не «конкретный спрайт». Каждый
вызов `render_procedural_piece` даёт уникальную пешку/коня/ферзя — той же
семантики, но разной формы.

API:

    img = render_procedural_piece(
        label='wK',         # 'wK', 'wQ', ..., 'bP'
        rng=random.Random(seed),
    )
    # img: PIL.Image RGBA 64×64, с прозрачным фоном.

Используется в `dataset_gen.py` через флаг `--use-procedural` (добавить
отдельно — этот модуль самодостаточный).

Что рисуется (общая схема):

  pawn   = база + конусная шейка + круглая голова
  rook   = база + прямоугольный ствол + зубцы наверху
  bishop = база + ствол + овальная «миттра» + поперечная щель
  knight = база + стилизованная голова лошади (полилиния)
  queen  = база + ствол + корона из 5–7 шариков
  king   = база + ствол + корона + крест сверху

Все параметры (пропорции, толщина обводки, цвет, наклон, дрожание контура)
сэмплятся независимо при каждом рендере.
"""

from __future__ import annotations

import math
import random
from typing import Dict, List, Tuple

from PIL import Image, ImageDraw, ImageFilter

CELL = 64


# ─── Цвет фигуры ────────────────────────────────────────────────────────

def _piece_colors(color: str, rng: random.Random,
                  book_style: bool = False) -> Tuple[Tuple[int, int, int, int],
                                                       Tuple[int, int, int, int]]:
    """Вернуть (fill, stroke) RGBA для фигуры цвета 'w' или 'b'.

    `book_style=False` (по умолчанию) — лёгкая рандомизация яркости + случайный
    «тонировочный» оттенок, чтобы белая не была всегда #FFF, а чёрная — всегда
    #000.

    `book_style=True` — стиль печатных диаграмм из учебников (Chess Informant,
    Майзелис): белая фигура = почти-белая заливка + тонкий тёмный контур
    (детали короны/юбки рисуются stroke и видны явно); чёрная фигура = почти-
    чёрная заливка (силуэт без внутренних линий). Используется напрямую в
    book_diagram_style.render_book_piece — НЕ через постпроцессинг маски,
    чтобы сохранить внутренние детали (шарики короны ферзя/короля, полосы).
    """
    if book_style:
        if color == "w":
            v = rng.randint(248, 255)        # почти чисто-белая заливка
            fill = (v, v, v, 255)
            sv = rng.randint(0, 30)
            stroke = (sv, sv, sv, 255)
        else:
            v = rng.randint(0, 20)           # почти чисто-чёрная заливка
            fill = (v, v, v, 255)
            stroke = (v, v, v, 255)          # stroke того же цвета — внутренние линии не видны
        return fill, stroke
    if color == "w":
        v = rng.randint(220, 255)
        tint = rng.randint(-8, 8)
        fill = (v, v, max(0, min(255, v + tint)), 255)
        sv = rng.randint(0, 60)
        stroke = (sv, sv, sv, 255)
    else:
        v = rng.randint(0, 45)
        tint = rng.randint(-5, 5)
        fill = (v, v, max(0, min(255, v + tint)), 255)
        sv = rng.randint(190, 255)
        stroke = (sv, sv, sv, 255) if rng.random() < 0.3 else (0, 0, 0, 255)
    return fill, stroke


# ─── Утилиты рисования ───────────────────────────────────────────────────

def _new_canvas() -> Image.Image:
    return Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))


def _polygon_with_outline(draw: ImageDraw.ImageDraw, pts: List[Tuple[float, float]],
                          fill, stroke, width: int) -> None:
    draw.polygon(pts, fill=fill, outline=stroke)
    if width > 1:
        # Обводка с переменной толщиной — рисуем линиями поверх.
        for i in range(len(pts)):
            p1 = pts[i]; p2 = pts[(i + 1) % len(pts)]
            draw.line([p1, p2], fill=stroke, width=width)


def _ellipse_outlined(draw: ImageDraw.ImageDraw, bbox, fill, stroke, width: int) -> None:
    draw.ellipse(bbox, fill=fill, outline=stroke, width=width)


# ─── Узкая базовая плитка (общая база для всех фигур) ────────────────────
#
# В классических стилях (cburnett, merida, kingside_default) база — это
# тонкая овальная/прямоугольная плитка под ногой фигуры, а не широкая
# трапеция «постамента». Высота ~3-5 px, ширина чуть больше ширины тела.

def _draw_base(draw: ImageDraw.ImageDraw, cx: float, cy_bottom: float,
               width: float, height: float, fill, stroke, sw: int) -> None:
    """Тонкая горизонтальная плитка: половина овала + контур."""
    x0, x1 = cx - width / 2, cx + width / 2
    y0 = cy_bottom - height
    # Овальный «диск» — выглядит как «блюдце» под фигурой.
    draw.ellipse((x0, y0, x1, cy_bottom), fill=fill, outline=stroke, width=sw)


# ─── Фигуры ──────────────────────────────────────────────────────────────

def draw_pawn(canvas: Image.Image, color: str, rng: random.Random,
              book_style: bool = False) -> None:
    """Пешка в канонической шахматной анатомии (cburnett/merida):
      - База: узкая овальная плитка под ногой.
      - Юбка: ШИРОКИЙ ПОЛУКРУГ (купол-колокол) — плоский низ, плавно
        округлый верх. Главный объём фигуры внизу.
      - Воротник: тонкое кольцо между юбкой и телом.
      - Тело: КРУГЛАЯ сфера/шар над юбкой (диаметр сопоставим с
        высотой юбки).
      - Голова: маленький круглый шарик на самой верхушке.

    Силуэт пешки = снеговик из двух кругов на колоколе: шар-тело
    стоит на полусфере-юбке, на нём — шарик-голова.
    """
    import io as _io, cairosvg
    fill, stroke = _piece_colors(color, rng, book_style=book_style)
    fill_hex = "#{:02x}{:02x}{:02x}".format(*fill[:3])
    stroke_hex = "#{:02x}{:02x}{:02x}".format(*stroke[:3])
    sw = rng.uniform(1.8, 2.6)

    cx = 32 + rng.uniform(-1.5, 1.5)
    base_y = 60 + rng.uniform(-2, 0)

    # ── База: тонкая овальная плитка ───────────────────────────
    base_w = rng.uniform(28, 34)
    base_h = rng.uniform(3.5, 5.5)
    base_cy = base_y - base_h / 2

    # ── Юбка: ПОЛУКРУГ (купол) ─────────────────────────────────
    # Плоский низ опирается на верх базы, верх — округлая дуга.
    skirt_w = rng.uniform(26, 32)
    skirt_h = rng.uniform(13, 17)
    skirt_bottom_y = base_y - base_h
    skirt_top_y = skirt_bottom_y - skirt_h
    # Полукруг через SVG arc: от (cx - skirt_w/2, skirt_bottom_y)
    # до (cx + skirt_w/2, skirt_bottom_y), радиус rx=skirt_w/2, ry=skirt_h.
    skirt_path = (
        f"M{cx - skirt_w/2},{skirt_bottom_y} "
        f"A{skirt_w/2},{skirt_h} 0 0 1 {cx + skirt_w/2},{skirt_bottom_y} "
        f"Z"
    )

    # ── Воротник: тонкое кольцо над юбкой ──────────────────────
    collar_w = rng.uniform(14, 18)
    collar_h = rng.uniform(2.2, 3.2)
    collar_y = skirt_top_y - collar_h * 0.3   # слегка перекрывает верх купола

    # ── Тело: КРУГЛАЯ сфера ────────────────────────────────────
    body_r = rng.uniform(7, 9)
    body_cy = collar_y - body_r * 0.85

    # ── Голова: маленький шарик ────────────────────────────────
    head_r = rng.uniform(4.5, 5.8)
    head_cy = body_cy - body_r - head_r * 0.5

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
      <ellipse cx="{cx:.2f}" cy="{base_cy:.2f}" rx="{base_w/2:.2f}" ry="{base_h/2:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>
      <path d="{skirt_path}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" stroke-linejoin="round"/>
      <rect x="{cx - collar_w/2:.2f}" y="{collar_y:.2f}" width="{collar_w:.2f}" height="{collar_h:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1"/>
      <circle cx="{cx:.2f}" cy="{body_cy:.2f}" r="{body_r:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>
      <circle cx="{cx:.2f}" cy="{head_cy:.2f}" r="{head_r:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>
    </svg>"""
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=CELL, output_height=CELL)
    piece = Image.open(_io.BytesIO(png)).convert("RGBA")
    canvas.alpha_composite(piece)


def draw_rook(canvas: Image.Image, color: str, rng: random.Random,
              book_style: bool = False) -> None:
    fill, stroke = _piece_colors(color, rng, book_style=book_style)
    draw = ImageDraw.Draw(canvas)
    sw = rng.randint(1, 3)
    cx = CELL / 2 + rng.uniform(-1.5, 1.5)
    base_y = CELL - rng.randint(4, 8)
    base_w = rng.uniform(28, 38)
    base_h = rng.uniform(5, 9)
    _draw_base(draw, cx, base_y, base_w, base_h, fill, stroke, sw)

    body_w = rng.uniform(20, 28)
    body_h = rng.uniform(22, 32)
    body_top_y = base_y - base_h - body_h
    body_bottom_y = base_y - base_h
    draw.rectangle((cx - body_w / 2, body_top_y,
                    cx + body_w / 2, body_bottom_y),
                   fill=fill, outline=stroke, width=sw)

    n_crenel = rng.choice([3, 4])
    crenel_h = rng.uniform(5, 10)
    cap_w = body_w + rng.uniform(2, 6)
    cap_top = body_top_y - crenel_h
    # Каркас «короны» — серия прямоугольников.
    seg_w = cap_w / (n_crenel * 2 - 1)
    crenel_pts = []
    x = cx - cap_w / 2
    crenel_pts.append((x, body_top_y))
    for i in range(n_crenel * 2 - 1):
        # 0, 2, 4 — зубцы (поднимаются), 1, 3 — впадины.
        is_tooth = (i % 2 == 0)
        y = cap_top if is_tooth else cap_top + crenel_h * 0.55
        crenel_pts.append((x, y))
        x += seg_w
        crenel_pts.append((x, y))
    crenel_pts.append((x, body_top_y))
    _polygon_with_outline(draw, crenel_pts, fill, stroke, sw)


def draw_bishop(canvas: Image.Image, color: str, rng: random.Random,
                book_style: bool = False) -> None:
    """Слон в реальной шахматной анатомии (KS-3155 v2):
      - Тело снизу: широкое основание + узкая «талия» + лёгкий «воротник».
      - Голова-митра: ОВАЛЬНАЯ/яйцевидная (НЕ заострённая как ёлка!),
        округлая сверху, чуть шире в середине.
      - Сверху митры — небольшой шарик-«фиал» (finial).
      - Главная отличительная черта слона — **диагональный разрез**
        («миттра-кат») в верхней части головы.

    Book-style: и белый, и чёрный — тёмный силуэт. Цвет кодируется
    наличием/отсутствием внутренних просветов (slit + finial-выделение
    у белого; чёрный — сплошной).
    """
    import io as _io, cairosvg
    fill, stroke = _piece_colors(color, rng, book_style=book_style)
    fill_hex = "#{:02x}{:02x}{:02x}".format(*fill[:3])
    stroke_hex = "#{:02x}{:02x}{:02x}".format(*stroke[:3])
    # KS-3160 (follow-up KS-3155): для book_style БЕЛОГО слона юбка
    # (широкая нижняя часть) красится тёмно-серым, а тело (узкое,
    # сразу под митрой) и сама митра остаются светлыми. Цель: дать
    # модели «чёрный пиксель» внутри белого слона, чтобы она не путала
    # цвета. Чёрный слон остаётся сплошным тёмным.
    if book_style and color == "w":
        v_skirt = rng.randint(60, 120)
        skirt_fill_hex = "#{:02x}{:02x}{:02x}".format(v_skirt, v_skirt, v_skirt)
    else:
        skirt_fill_hex = fill_hex
    sw = rng.uniform(1.8, 2.6)

    cx = 32 + rng.uniform(-1.5, 1.5)
    base_y = 60 + rng.uniform(-2, 0)

    # ── База: тонкая овальная плитка под юбкой ────────────────────
    base_w = rng.uniform(22, 28)
    base_h = rng.uniform(3, 4.5)
    base_disc_cy = base_y - base_h / 2

    # ── Юбка: ШИРОКАЯ нижняя часть слона ──────────────────────────
    # По анатомии: юбка занимает ~40% высоты фигуры, шире тела вдвое.
    # Для белого слона — тёмная. Для чёрного — того же цвета, что
    # и остальное (сплошной силуэт).
    skirt_bottom_y = base_y - base_h
    skirt_h = rng.uniform(8, 11)
    skirt_top_y = skirt_bottom_y - skirt_h
    skirt_bottom_w = rng.uniform(28, 34)  # шире базы (юбка «висит»)
    skirt_top_w = rng.uniform(12, 16)     # переход к телу
    skirt_path = (
        f"M{cx - skirt_top_w/2},{skirt_top_y} "
        f"L{cx + skirt_top_w/2},{skirt_top_y} "
        f"C{cx + skirt_bottom_w/2},{skirt_bottom_y - skirt_h*0.2} "
            f"{cx + skirt_bottom_w/2},{skirt_bottom_y} "
            f"{cx + skirt_bottom_w/2},{skirt_bottom_y} "
        f"L{cx - skirt_bottom_w/2},{skirt_bottom_y} "
        f"C{cx - skirt_bottom_w/2},{skirt_bottom_y} "
            f"{cx - skirt_bottom_w/2},{skirt_bottom_y - skirt_h*0.2} "
            f"{cx - skirt_top_w/2},{skirt_top_y} "
        f"Z"
    )

    # ── Тело: УЗКАЯ КОРОТКАЯ часть между юбкой и митрой ───────────
    # Анатомия: тело — короткое, узкое, явно `светлое` у белого слона
    # (контрастирует с тёмной юбкой). У чёрного — того же тёмного цвета.
    body_bottom_y = skirt_top_y
    body_h = rng.uniform(5, 8)
    body_top_y = body_bottom_y - body_h
    body_bottom_w = skirt_top_w * 0.85
    body_top_w = rng.uniform(8, 11)
    body_path = (
        f"M{cx - body_bottom_w/2},{body_bottom_y} "
        f"L{cx + body_bottom_w/2},{body_bottom_y} "
        f"L{cx + body_top_w/2},{body_top_y} "
        f"L{cx - body_top_w/2},{body_top_y} "
        f"Z"
    )

    # ── Воротник: тонкая горизонтальная полоса над телом ──────────
    collar_h = rng.uniform(2.0, 3.0)
    collar_w = body_top_w + rng.uniform(2, 4)
    collar_y = body_top_y - collar_h

    # ── Митра: ОВАЛЬНАЯ (яйцо), округлая сверху ───────────────────
    # Это главное отличие от ёлки: верх НЕ заострённый, а скруглённый.
    # Митра шире в середине, чем у верха, и шире у низа.
    mitre_h = rng.uniform(20, 26)
    mitre_w = rng.uniform(14, 18)                 # максимальная ширина в «талии»
    mitre_bottom_y = collar_y
    mitre_top_y = mitre_bottom_y - mitre_h
    mitre_belly_y = mitre_bottom_y - mitre_h * 0.55  # самое широкое место
    mitre_top_w = mitre_w * 0.18                  # верх — узкий, но не точка
    mitre_bottom_w = mitre_w * 0.50               # низ — стыкуется с воротником

    # Овал-«яйцо» через Bezier-кривые: низ → пузо → округлый верх.
    mitre_path = (
        f"M{cx - mitre_bottom_w/2},{mitre_bottom_y} "
        # левая нижняя четверть → левый бок (пузо)
        f"C{cx - mitre_w/2},{mitre_bottom_y - mitre_h*0.15} "
            f"{cx - mitre_w/2},{mitre_belly_y + mitre_h*0.05} "
            f"{cx - mitre_w/2},{mitre_belly_y} "
        # левый бок → левый верх (сужение)
        f"C{cx - mitre_w/2},{mitre_belly_y - mitre_h*0.20} "
            f"{cx - mitre_top_w/2 - 1.5},{mitre_top_y + mitre_h*0.10} "
            f"{cx - mitre_top_w/2},{mitre_top_y + mitre_h*0.04} "
        # округлая шапочка сверху
        f"C{cx - mitre_top_w/2},{mitre_top_y - 0.5} "
            f"{cx + mitre_top_w/2},{mitre_top_y - 0.5} "
            f"{cx + mitre_top_w/2},{mitre_top_y + mitre_h*0.04} "
        # правый верх → правый бок
        f"C{cx + mitre_top_w/2 + 1.5},{mitre_top_y + mitre_h*0.10} "
            f"{cx + mitre_w/2},{mitre_belly_y - mitre_h*0.20} "
            f"{cx + mitre_w/2},{mitre_belly_y} "
        # правый бок → правый низ
        f"C{cx + mitre_w/2},{mitre_belly_y + mitre_h*0.05} "
            f"{cx + mitre_w/2},{mitre_bottom_y - mitre_h*0.15} "
            f"{cx + mitre_bottom_w/2},{mitre_bottom_y} "
        f"Z"
    )

    # ── Шарик-«фиал» на верхушке митры ────────────────────────────
    finial_r = rng.uniform(1.6, 2.4)
    finial_cy = mitre_top_y - finial_r * 0.6
    finial_svg = (
        f'<circle cx="{cx:.2f}" cy="{finial_cy:.2f}" r="{finial_r:.2f}" '
        f'fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>'
    )

    # ── Диагональный разрез («миттра-кат») ───────────────────────
    # Главный визуальный признак слона. Всегда КОНТРАСТНЫЙ к заливке
    # митры: на белой/светлой заливке — тёмный (stroke), на чёрной
    # заливке — светлый (контрастная прорезь, как в книжных диаграммах
    # печатают чёрного слона: тёмный силуэт с явной светлой щелью).
    fill_brightness = sum(fill[:3]) / 3
    if fill_brightness < 128:
        v_light = rng.randint(235, 255)
        slit_color = "#{:02x}{:02x}{:02x}".format(v_light, v_light, v_light)
    else:
        slit_color = stroke_hex
    slit_cy = mitre_top_y + mitre_h * 0.32
    slit_len = mitre_w * 0.85
    slit_angle_rad = math.radians(rng.uniform(-32, -22))  # наклон вниз-направо
    sx = slit_len / 2 * math.cos(slit_angle_rad)
    sy = slit_len / 2 * math.sin(slit_angle_rad)
    slit_w = rng.uniform(2.2, 3.0)
    slit_svg = (
        f'<line x1="{cx - sx:.2f}" y1="{slit_cy - sy:.2f}" '
        f'x2="{cx + sx:.2f}" y2="{slit_cy + sy:.2f}" '
        f'stroke="{slit_color}" stroke-width="{slit_w:.2f}" stroke-linecap="round"/>'
    )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
      <ellipse cx="{cx:.2f}" cy="{base_disc_cy:.2f}" rx="{base_w/2:.2f}" ry="{base_h/2:.2f}" fill="{skirt_fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>
      <path d="{skirt_path}" fill="{skirt_fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" stroke-linejoin="round"/>
      <path d="{body_path}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" stroke-linejoin="round"/>
      <rect x="{cx - collar_w/2:.2f}" y="{collar_y:.2f}" width="{collar_w:.2f}" height="{collar_h:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1.2"/>
      <path d="{mitre_path}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" stroke-linejoin="round"/>
      {slit_svg}
      {finial_svg}
    </svg>"""
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=CELL, output_height=CELL)
    piece = Image.open(_io.BytesIO(png)).convert("RGBA")
    canvas.alpha_composite(piece)


def draw_knight(canvas: Image.Image, color: str, rng: random.Random,
                book_style: bool = False) -> None:
    """Конь через SVG-кривые Безье. Профиль лошади смотрит вправо,
    с гривой сзади, треугольным ухом, длинной мордой."""
    import io as _io, cairosvg
    fill, stroke = _piece_colors(color, rng, book_style=book_style)
    fill_hex   = "#{:02x}{:02x}{:02x}".format(*fill[:3])
    stroke_hex = "#{:02x}{:02x}{:02x}".format(*stroke[:3])
    sw = rng.uniform(1.5, 2.8)

    # Параметры стилизованной лошади.
    nose_x   = 50 + rng.uniform(-2, 2)         # кончик морды
    nose_y   = 30 + rng.uniform(-2, 2)
    forehead = 38 + rng.uniform(-2, 2)         # лоб (изгиб вверх над мордой)
    ear_x    = 30 + rng.uniform(-1, 1)         # основание уха
    ear_top  = 8  + rng.uniform(-2, 2)         # верх уха
    mane_x1  = 22 + rng.uniform(-1, 2)         # верх гривы
    mane_x2  = 14 + rng.uniform(-2, 2)         # низ гривы
    mane_y2  = 38 + rng.uniform(-2, 2)
    neck_l   = 18 + rng.uniform(-2, 2)         # шея слева внизу
    base_top = 50
    base_x0  = 12
    base_x1  = 56

    # Контур коня без базы-трапеции — заканчивается узкой шейкой
    # которая стыкуется с тонкой плиткой-эллипсом внизу.
    path = (
        f"M{nose_x},{nose_y} "
        f"C{nose_x-4},{nose_y-6} {forehead+2},{nose_y-10} {forehead},{nose_y-12} "
        f"C{forehead-3},{nose_y-16} {ear_x+2},{ear_top+6} {ear_x},{ear_top} "
        f"C{ear_x-2},{ear_top+4} {mane_x1+2},{ear_top+10} {mane_x1},{ear_top+14} "
        f"L{mane_x1+1},{ear_top+18} "
        f"L{mane_x1-3},{ear_top+19} "
        f"L{mane_x1+1},{ear_top+22} "
        f"L{mane_x1-4},{ear_top+24} "
        f"L{mane_x1+0},{ear_top+27} "
        f"L{mane_x2},{mane_y2} "
        f"C{mane_x2-2},{mane_y2+4} {neck_l-1},{base_top-4} {neck_l},{base_top} "
        # сходимся к узкой основанию шеи
        f"L{neck_l+4},{base_top+1} "
        f"L{base_x1-6},{base_top+1} "
        f"C{base_x1-6},{nose_y+8} {nose_x+2},{nose_y+6} {nose_x},{nose_y} "
        f"Z"
    )

    eye_cx = forehead + rng.uniform(2, 5)
    eye_cy = nose_y - rng.uniform(8, 12)

    base_disc_cx = (neck_l + base_x1 - 6) / 2
    base_disc_w = (base_x1 - base_x0) * 0.7
    base_disc_h = 4.0 + rng.uniform(0, 2)
    base_disc_cy = base_top + base_disc_h / 2 + 1

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
      <ellipse cx="{base_disc_cx:.2f}" cy="{base_disc_cy:.2f}" rx="{base_disc_w/2:.2f}" ry="{base_disc_h/2:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>
      <path d="{path}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="{eye_cx}" cy="{eye_cy}" r="{rng.uniform(1.0,1.8):.2f}" fill="{stroke_hex}"/>
    </svg>"""
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=CELL, output_height=CELL)
    piece = Image.open(_io.BytesIO(png)).convert("RGBA")
    canvas.alpha_composite(piece)


def draw_queen_cburnett(canvas: Image.Image, color: str, rng: random.Random,
                         book_style: bool = False) -> None:
    """Ферзь в стиле cburnett: широкая полосатая юбка + волнистый
    воротник (5 «лепестков» вверх) + 5 крупных шариков-вершин.
    """
    import io as _io, cairosvg
    fill, stroke = _piece_colors(color, rng, book_style=book_style)
    fill_hex   = "#{:02x}{:02x}{:02x}".format(*fill[:3])
    stroke_hex = "#{:02x}{:02x}{:02x}".format(*stroke[:3])
    # Цвета деталей. Книжная диаграмма с ЧЁРНЫМ ферзём:
    #   - детали ВНУТРИ тела (полосы юбки) — светлые (накладываются
    #     на чёрный fill, иначе невидимы);
    #   - детали НАД телом (корона, шарики, воротник) — ЧЁРНЫЕ (на
    #     белой клетке естественно видны как тёмное на белом).
    # Иначе corona получалась бы «инверсной» — её цвет не совпадал бы
    # с цветом самой фигуры, что не соответствует реальному book-style.
    if book_style and color == "b":
        v_det = rng.randint(220, 255)
        inner_detail_hex = "#{:02x}{:02x}{:02x}".format(v_det, v_det, v_det)
    else:
        inner_detail_hex = stroke_hex
    sw = rng.uniform(1.8, 2.6)

    cx = 32 + rng.uniform(-1.5, 1.5)
    base_y = 60 + rng.uniform(-2, 0)

    # Юбка как у короля-cburnett (полосатая).
    body_top_y = 36 + rng.uniform(-2, 2)
    body_bottom_y = base_y - 2
    body_bottom_w = rng.uniform(46, 54)
    body_top_w = rng.uniform(28, 34)
    body_path = (
        f"M{cx - body_bottom_w/2},{body_bottom_y} "
        f"C{cx - body_bottom_w/2 - 2},{body_top_y + 4} "
            f"{cx - body_top_w/2 - 2},{body_top_y} "
            f"{cx - body_top_w/2},{body_top_y} "
        f"L{cx + body_top_w/2},{body_top_y} "
        f"C{cx + body_top_w/2 + 2},{body_top_y} "
            f"{cx + body_bottom_w/2 + 2},{body_top_y + 4} "
            f"{cx + body_bottom_w/2},{body_bottom_y} "
        f"Z"
    )
    # Полосы юбки — НА теле (внутри fill). Для book-style чёрного ферзя
    # они светлые (иначе невидимы на чёрной заливке).
    stripes = ""
    for k in (0.40, 0.70):
        sy = body_top_y + (body_bottom_y - body_top_y) * k
        w_at = body_top_w + (body_bottom_w - body_top_w) * k
        stripes += (
            f'<line x1="{cx - w_at/2 + 3:.2f}" y1="{sy:.2f}" '
            f'x2="{cx + w_at/2 - 3:.2f}" y2="{sy:.2f}" '
            f'stroke="{inner_detail_hex}" stroke-width="{sw}" stroke-linecap="round"/>'
        )

    # Корона: 5 шариков сверху над воротником. Шарики маленькие в
    # пропорции — крупнее «волна воротника», а не сами шарики.
    n_balls = 5
    if book_style:
        ball_r = rng.uniform(2.6, 3.4)
        crown_w = rng.uniform(34, 40)
    else:
        ball_r = rng.uniform(2.4, 3.2)
        crown_w = rng.uniform(28, 34)
    crown_top_y = body_top_y - rng.uniform(8, 12)
    step = crown_w / (n_balls - 1)
    positions = [cx - crown_w/2 + i * step for i in range(n_balls)]

    # Волнистый воротник: ломаная линия между основаниями шариков и юбкой.
    # Находится НАД телом → цвет фигуры (stroke_hex) — у чёрного ферзя
    # это чёрный, и на белой клетке он виден как тёмная корона.
    band_top_y = crown_top_y + ball_r * 0.6
    band_bottom_y = body_top_y
    waves_pts = []
    waves_pts.append((cx - crown_w/2 - 2, band_bottom_y))
    for i, x in enumerate(positions):
        waves_pts.append((x, band_top_y))
        if i < n_balls - 1:
            valley_x = (x + positions[i + 1]) / 2
            valley_y = band_top_y + (band_bottom_y - band_top_y) * 0.65
            waves_pts.append((valley_x, valley_y))
    waves_pts.append((cx + crown_w/2 + 2, band_bottom_y))
    wave_path_pts = " ".join(f"{p[0]:.2f},{p[1]:.2f}" for p in waves_pts)
    wave_collar = (
        f'<polyline points="{wave_path_pts}" '
        f'fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" '
        f'stroke-linejoin="round"/>'
    )

    # Шарики короны — НАД телом, цвет совпадает с цветом фигуры
    # (на белой клетке естественно видны как тёмные на белом).
    balls = ""
    for x in positions:
        balls += (
            f'<circle cx="{x:.2f}" cy="{crown_top_y:.2f}" r="{ball_r:.2f}" '
            f'fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>'
        )

    # База — двойная плита.
    base_h = 4.5
    base1_y = base_y - base_h
    base2_y = base_y - base_h * 0.35
    base_w_total = body_bottom_w + 4

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
      {wave_collar}
      {balls}
      <path d="{body_path}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" stroke-linejoin="round"/>
      {stripes}
      <rect x="{cx - base_w_total/2:.2f}" y="{base1_y:.2f}" width="{base_w_total:.2f}" height="{base_h * 0.55:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1.2"/>
      <rect x="{cx - base_w_total*0.45:.2f}" y="{base2_y:.2f}" width="{base_w_total*0.9:.2f}" height="{base_h * 0.40:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1"/>
    </svg>"""
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=CELL, output_height=CELL)
    piece = Image.open(_io.BytesIO(png)).convert("RGBA")
    canvas.alpha_composite(piece)


def draw_queen(canvas: Image.Image, color: str, rng: random.Random,
                book_style: bool = False) -> None:
    """Disp по двум вариантам ферзя — 50/50."""
    if rng.random() < 0.5:
        draw_queen_cburnett(canvas, color, rng, book_style=book_style)
    else:
        _draw_queen_classic(canvas, color, rng, book_style=book_style)


def _draw_queen_classic(canvas: Image.Image, color: str, rng: random.Random,
                         book_style: bool = False) -> None:
    """Ферзь: грушевидное тело + воротник + корона из 5-7 шипов со
    шариками наверху. Один силуэт через SVG-path (плавные кривые).
    """
    import io as _io, cairosvg
    fill, stroke = _piece_colors(color, rng, book_style=book_style)
    fill_hex   = "#{:02x}{:02x}{:02x}".format(*fill[:3])
    stroke_hex = "#{:02x}{:02x}{:02x}".format(*stroke[:3])
    # Цвета деталей в classic варианте ферзя. См. draw_queen_cburnett:
    # детали ВНУТРИ тела (тут их нет) — inner_detail_hex (светлый для
    # book-style black). Детали НАД телом (корона, ножки, шарики, зубчики
    # воротника) — цвет фигуры (stroke_hex) — у чёрного ферзя чёрные, на
    # белой клетке естественно видны как «лучистая» корона.
    if book_style and color == "b":
        v_det = rng.randint(220, 255)
        inner_detail_hex = "#{:02x}{:02x}{:02x}".format(v_det, v_det, v_det)
    else:
        inner_detail_hex = stroke_hex
    sw = rng.uniform(1.5, 2.8)

    # Cburnett-style ферзь: ШИРОКОЕ грушевидное тело, занимает почти
    # всю клетку. Плита-база внизу 2 уровня (две горизонтальные плитки).
    cx = 32 + rng.uniform(-1.5, 1.5)
    base_y = 60 + rng.uniform(-2, 0)
    base_w = rng.uniform(46, 54)              # сильно шире, чем было
    base_h = rng.uniform(4, 6)
    body_bottom_y = base_y - base_h
    body_h = rng.uniform(18, 24)
    body_top_y = body_bottom_y - body_h
    neck_y = body_top_y - rng.uniform(3, 5)
    body_bottom_w = base_w * 0.78             # тело почти как база
    body_belly_w = base_w * 0.95              # «брюшко» — самое широкое
    neck_w = rng.uniform(13, 17)
    crown_band_h = rng.uniform(3, 5)
    crown_band_w = rng.uniform(22, 28)
    crown_band_y = neck_y - crown_band_h

    # Тело-«юбка»: широкое внизу, ещё шире в середине, сужается к шее.
    body_path = (
        f"M{cx - body_bottom_w/2},{body_bottom_y} "
        f"C{cx - body_belly_w/2 - 1},{body_bottom_y - body_h*0.55} "
            f"{cx - neck_w/2 - 1},{body_top_y - 1} "
            f"{cx - neck_w/2},{neck_y} "
        f"L{cx + neck_w/2},{neck_y} "
        f"C{cx + neck_w/2 + 1},{body_top_y - 1} "
            f"{cx + body_belly_w/2 + 1},{body_bottom_y - body_h*0.55} "
            f"{cx + body_bottom_w/2},{body_bottom_y} "
        f"Z"
    )

    # Базы — две горизонтальные плитки (как у cburnett: толстая + тоньше).
    base1_y = base_y - base_h
    base1_h = base_h * 0.55
    base2_y = base_y - base_h * 0.35
    base2_h = base_h * 0.40
    base_disc_y = base_disc_y2 = 0  # для совместимости

    # Корона ферзя в классическом cburnett-стиле: 5 круглых шариков на
    # тонких ВЕРТИКАЛЬНЫХ палочках. Без треугольных зубцов.
    # Пропорции: ножки ДЛИННЫЕ (10-16 px), шарики МАЛЕНЬКИЕ (~ 1.8-3.0 r).
    # Так корона имеет узнаваемый «лучистый» силуэт, а не «толстую шапку
    # с круглыми пятнами». На book-style палочки контрастнее (через
    # detail_hex), радиус шарика немного крупнее, но всё равно меньше
    # длины ножки.
    n_balls = rng.choice([5, 5, 6, 7])
    if book_style:
        ball_r = rng.uniform(2.4, 3.2)
        stem_w = rng.uniform(1.8, 2.6)
        stem_h = rng.uniform(11, 16)
    else:
        ball_r = rng.uniform(1.8, 2.6)
        stem_w = rng.uniform(1.2, 2.0)
        stem_h = rng.uniform(10, 15)
    # Раздвинем шарики так, чтобы они НЕ пересекались (центр-расстояние >= 2.3*r)
    min_step = ball_r * 2.3
    needed_w = min_step * (n_balls - 1) + 2 * (ball_r + 1)
    use_w = max(crown_band_w, needed_w)
    margin = ball_r + 1
    step = (use_w - 2 * margin) / max(1, n_balls - 1)
    ball_positions = [cx - use_w/2 + margin + i * step for i in range(n_balls)]
    ball_cy = crown_band_y - stem_h - ball_r * 0.5

    # Палочки. В классическом cburnett-стиле stems расходятся ЛУЧАМИ от
    # центра воротника: центральная stem вертикальная, крайние —
    # под углом ±14-22° наружу. Низ stem'ов кучнее (на crown_band), верх
    # (где шарики) разнесён `use_w` пикселей. Цвет — фигура целиком
    # (stroke_hex), детали НАД телом видны естественно.
    import math as _math
    center_i = (n_balls - 1) / 2.0
    max_tilt_deg = rng.uniform(14, 22)
    stems = ""
    for i, x_top in enumerate(ball_positions):
        ratio = (i - center_i) / max(center_i, 0.5)   # -1..+1
        ang = _math.radians(ratio * max_tilt_deg)
        x_bottom = x_top - stem_h * _math.tan(ang)
        stems += (
            f'<line x1="{x_top:.2f}" y1="{ball_cy:.2f}" '
            f'x2="{x_bottom:.2f}" y2="{crown_band_y:.2f}" '
            f'stroke="{stroke_hex}" stroke-width="{stem_w:.2f}" '
            f'stroke-linecap="round"/>'
        )

    # Шарики — НАД телом, цвет фигуры.
    balls = ""
    for x in ball_positions:
        balls += (
            f'<circle cx="{x:.2f}" cy="{ball_cy:.2f}" r="{ball_r:.2f}" '
            f'fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>'
        )
    spikes = ""  # больше не используется

    # Зубчатый воротничок: 4-6 маленьких треугольников остриями ВНИЗ.
    # Над телом / на стыке — цвет фигуры.
    collar_teeth = ""
    n_teeth = rng.choice([4, 5, 6])
    tooth_h = rng.uniform(3, 5)
    tooth_step = crown_band_w / n_teeth
    for i in range(n_teeth):
        tx0 = cx - crown_band_w/2 + i * tooth_step
        tx1 = tx0 + tooth_step
        txm = (tx0 + tx1) / 2
        collar_teeth += (
            f'<polygon points="{tx0:.2f},{crown_band_y + crown_band_h:.2f} '
            f'{tx1:.2f},{crown_band_y + crown_band_h:.2f} '
            f'{txm:.2f},{crown_band_y + crown_band_h + tooth_h:.2f}" '
            f'fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{max(0.8, sw - 0.5):.2f}"/>'
        )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
      <path d="{body_path}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" stroke-linejoin="round"/>
      <rect x="{cx - base_w/2:.2f}" y="{base1_y:.2f}" width="{base_w:.2f}" height="{base1_h:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1.2"/>
      <rect x="{cx - base_w*0.45:.2f}" y="{base2_y:.2f}" width="{base_w*0.9:.2f}" height="{base2_h:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1"/>
      {collar_teeth}
      <rect x="{cx - crown_band_w/2:.2f}" y="{crown_band_y:.2f}" width="{crown_band_w:.2f}" height="{crown_band_h:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1"/>
      {stems}
      {balls}
    </svg>"""
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=CELL, output_height=CELL)
    piece = Image.open(_io.BytesIO(png)).convert("RGBA")
    canvas.alpha_composite(piece)


def draw_king_cburnett(canvas: Image.Image, color: str, rng: random.Random,
                        book_style: bool = False) -> None:
    """Король в стиле cburnett: полосатая юбка (3 горизонтальных кольца)
    + корона из двух круглых «ушей» слева/справа + тонкий центральный
    элемент с маленьким крестом между ушами."""
    import io as _io, cairosvg
    fill, stroke = _piece_colors(color, rng, book_style=book_style)
    fill_hex   = "#{:02x}{:02x}{:02x}".format(*fill[:3])
    stroke_hex = "#{:02x}{:02x}{:02x}".format(*stroke[:3])
    sw = rng.uniform(1.8, 2.6)

    cx = 32 + rng.uniform(-1.5, 1.5)
    base_y = 60 + rng.uniform(-2, 0)

    # Тело-«юбка» — широкое усечённое полу-полукружие с 3 горизонтальными
    # полосами внутри.
    body_top_y = 36 + rng.uniform(-2, 2)
    body_bottom_y = base_y - 2
    body_bottom_w = rng.uniform(46, 54)
    body_top_w = rng.uniform(30, 36)

    body_path = (
        f"M{cx - body_bottom_w/2},{body_bottom_y} "
        f"C{cx - body_bottom_w/2 - 2},{body_top_y + 4} "
            f"{cx - body_top_w/2 - 2},{body_top_y} "
            f"{cx - body_top_w/2},{body_top_y} "
        f"L{cx + body_top_w/2},{body_top_y} "
        f"C{cx + body_top_w/2 + 2},{body_top_y} "
            f"{cx + body_bottom_w/2 + 2},{body_top_y + 4} "
            f"{cx + body_bottom_w/2},{body_bottom_y} "
        f"Z"
    )

    # Полосы — две горизонтальные линии-разделители внутри юбки.
    stripes = ""
    for k in (0.40, 0.70):
        sy = body_top_y + (body_bottom_y - body_top_y) * k
        # Ширина полосы зависит от высоты на «трапеции».
        w_at = body_top_w + (body_bottom_w - body_top_w) * k
        stripes += (
            f'<line x1="{cx - w_at/2 + 3:.2f}" y1="{sy:.2f}" '
            f'x2="{cx + w_at/2 - 3:.2f}" y2="{sy:.2f}" '
            f'stroke="{stroke_hex}" stroke-width="{sw}" stroke-linecap="round"/>'
        )

    # Два круглых «уха» (корона). Каждое — большой круг по бокам.
    ear_r = rng.uniform(8, 10)
    ear_y = body_top_y - ear_r * 0.4
    ear_left_x = cx - rng.uniform(10, 13)
    ear_right_x = cx + rng.uniform(10, 13)
    ears = (
        f'<circle cx="{ear_left_x:.2f}" cy="{ear_y:.2f}" r="{ear_r:.2f}" '
        f'fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>'
        f'<circle cx="{ear_right_x:.2f}" cy="{ear_y:.2f}" r="{ear_r:.2f}" '
        f'fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>'
    )

    # Центральный тонкий «крест» между ушами.
    cross_top = ear_y - ear_r - rng.uniform(4, 7)
    cross_h = ear_y - cross_top + ear_r * 0.5
    cross = (
        f'<rect x="{cx - 1:.2f}" y="{cross_top:.2f}" width="2" height="{cross_h:.2f}" '
        f'fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{max(0.8, sw - 0.5):.2f}"/>'
        f'<circle cx="{cx:.2f}" cy="{cross_top:.2f}" r="{rng.uniform(1.8, 2.6):.2f}" '
        f'fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{max(0.8, sw - 0.5):.2f}"/>'
    )

    # База — двойная плита.
    base_h = 4.5
    base1_y = base_y - base_h
    base2_y = base_y - base_h * 0.35
    base_w = body_bottom_w + 4

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
      {ears}
      {cross}
      <path d="{body_path}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" stroke-linejoin="round"/>
      {stripes}
      <rect x="{cx - base_w/2:.2f}" y="{base1_y:.2f}" width="{base_w:.2f}" height="{base_h * 0.55:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1.2"/>
      <rect x="{cx - base_w*0.45:.2f}" y="{base2_y:.2f}" width="{base_w*0.9:.2f}" height="{base_h * 0.40:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1"/>
    </svg>"""
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=CELL, output_height=CELL)
    piece = Image.open(_io.BytesIO(png)).convert("RGBA")
    canvas.alpha_composite(piece)


def draw_king(canvas: Image.Image, color: str, rng: random.Random,
              book_style: bool = False) -> None:
    """Disp по двум вариантам короля. С вероятностью 50/50 рисуется
    либо classic (крест+корона+тело), либо cburnett-style (два уха+полосы).
    """
    if rng.random() < 0.5:
        draw_king_cburnett(canvas, color, rng, book_style=book_style)
    else:
        _draw_king_classic(canvas, color, rng, book_style=book_style)


def _draw_king_classic(canvas: Image.Image, color: str, rng: random.Random,
                        book_style: bool = False) -> None:
    """Король: круглая/грушевидная база + воротник + полусфера сверху +
    крест. Силуэт через SVG-path с плавными кривыми (lichess_alpha-style).
    """
    import io as _io, cairosvg
    fill, stroke = _piece_colors(color, rng, book_style=book_style)
    fill_hex   = "#{:02x}{:02x}{:02x}".format(*fill[:3])
    stroke_hex = "#{:02x}{:02x}{:02x}".format(*stroke[:3])
    sw = rng.uniform(1.5, 2.8)

    # Cburnett-style король: ШИРОКОЕ грушевидное тело + двойная плита внизу.
    cx = 32 + rng.uniform(-1.5, 1.5)
    base_y = 60 + rng.uniform(-2, 0)
    base_w = rng.uniform(46, 54)
    base_h = rng.uniform(4, 6)
    body_bottom_y = base_y - base_h

    body_h = rng.uniform(18, 24)
    body_top_y = body_bottom_y - body_h
    belly_w = base_w * 0.95
    neck_w  = rng.uniform(12, 15)
    body_bottom_w = base_w * 0.78

    body_path = (
        f"M{cx - body_bottom_w/2},{body_bottom_y} "
        f"C{cx - belly_w/2 - 1},{body_bottom_y - body_h*0.55} "
            f"{cx - neck_w/2 - 1.5},{body_top_y - 1} "
            f"{cx - neck_w/2},{body_top_y} "
        f"L{cx + neck_w/2},{body_top_y} "
        f"C{cx + neck_w/2 + 1.5},{body_top_y - 1} "
            f"{cx + belly_w/2 + 1},{body_bottom_y - body_h*0.55} "
            f"{cx + body_bottom_w/2},{body_bottom_y} "
        f"Z"
    )

    # Двойная плита-база.
    base1_y = base_y - base_h
    base1_h = base_h * 0.55
    base2_y = base_y - base_h * 0.35
    base2_h = base_h * 0.40

    # Воротник — узкая полоса сверху тела.
    collar_h = rng.uniform(3, 5)
    collar_w = rng.uniform(15, 19)
    collar_y_top = body_top_y - collar_h

    # «Голова» (круглая часть под крестом) — полусфера.
    head_r = rng.uniform(5, 7)
    head_cy = collar_y_top - head_r * 0.5
    head_path = (
        f"M{cx - head_r},{collar_y_top} "
        f"A{head_r},{head_r} 0 0 1 {cx + head_r},{collar_y_top} "
        f"Z"
    )

    # Крест сверху — главная отличительная черта короля.
    cross_v_h = rng.uniform(9, 13)
    cross_v_w = rng.uniform(2.5, 4)
    cross_h_h = rng.uniform(2.5, 4)
    cross_h_w = rng.uniform(8, 12)
    cross_bottom = head_cy - head_r * 0.6  # верх головы
    cross_top = cross_bottom - cross_v_h
    cross_bar_y = cross_top + cross_v_h * 0.30

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
      <path d="{body_path}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" stroke-linejoin="round"/>
      <rect x="{cx - base_w/2:.2f}" y="{base1_y:.2f}" width="{base_w:.2f}" height="{base1_h:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1.2"/>
      <rect x="{cx - base_w*0.45:.2f}" y="{base2_y:.2f}" width="{base_w*0.9:.2f}" height="{base2_h:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1"/>
      <rect x="{cx - collar_w/2:.2f}" y="{collar_y_top:.2f}" width="{collar_w:.2f}" height="{collar_h:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" rx="1.5"/>
      <path d="{head_path}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}" stroke-linejoin="round"/>
      <rect x="{cx - cross_v_w/2:.2f}" y="{cross_top:.2f}" width="{cross_v_w:.2f}" height="{cross_v_h:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>
      <rect x="{cx - cross_h_w/2:.2f}" y="{cross_bar_y:.2f}" width="{cross_h_w:.2f}" height="{cross_h_h:.2f}" fill="{fill_hex}" stroke="{stroke_hex}" stroke-width="{sw}"/>
    </svg>"""
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=CELL, output_height=CELL)
    piece = Image.open(_io.BytesIO(png)).convert("RGBA")
    canvas.alpha_composite(piece)


# ─── Диспетчер ───────────────────────────────────────────────────────────

_DISPATCH = {
    "K": draw_king,
    "Q": draw_queen,
    "R": draw_rook,
    "B": draw_bishop,
    "N": draw_knight,
    "P": draw_pawn,
}


def render_procedural_piece(label: str, rng: random.Random,
                              book_style: bool = False) -> Image.Image:
    """Сгенерировать одну фигуру с случайными параметрами.

    `label` — 'wK'..'bP' (двусимвольный код как в датасете).
    `book_style` — если True, рисуется в стиле печатных книжных диаграмм:
    белые = почти-белая заливка с тонким тёмным контуром (детали короны
    и юбки видны явно), чёрные = почти-чёрный сплошной силуэт.
    """
    if len(label) != 2 or label[0] not in "wb" or label[1] not in _DISPATCH:
        raise ValueError(f"bad label: {label!r}")
    color = label[0]
    piece = label[1]
    canvas = _new_canvas()
    _DISPATCH[piece](canvas, color, rng, book_style=book_style)
    # Лёгкий blur 30% случаев — имитация антиалиасинга в рендере.
    if rng.random() < 0.3:
        canvas = canvas.filter(ImageFilter.GaussianBlur(radius=rng.uniform(0.3, 0.8)))
    return canvas
