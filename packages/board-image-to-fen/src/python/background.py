"""KS-3091 follow-up (board-recog v3, фон-инвариантность).

Процедурные фоны клетки. Цель — научить модель **игнорировать фон**
и опираться только на силуэт фигуры. На входе у render_cell сейчас
сплошной цвет, поэтому модель цепляется к нему как к признаку
"light/dark" и сваливается на out-of-distribution фонах (штриховка
учебников, тени, текстуры, фото).

Идея: фон каждой клетки на каждом шаге выбирается случайно из набора
генераторов. Light/dark задаётся не цветом, а средней яркостью паттерна
(на light клетке среднее ~ 0.7, на dark ~ 0.3) — но конкретный пиксель
может быть каким угодно.

Генераторы:
  - solid              — сплошной цвет (классика)
  - hatch              — диагональные/перекрёстные/прямые штрихи случайной
                          плотности, угла, толщины
  - dots               — точечный паттерн
  - perlin             — Perlin-подобный шум (через смешивание октав
                          гауссова шума)
  - gradient           — линейный градиент случайного направления
  - noise              — мелкий гауссов шум поверх базы

Все генераторы возвращают PIL.Image RGB 64×64. Не зависят от piece-set'а,
не используют внешние данные.

Использование:

    rng = random.Random(seed)
    bg = render_background(bg_kind="dark", rng=rng)
    # bg: PIL.Image RGB 64×64

`bg_kind` — "light" или "dark". Семантика сохраняется (средняя яркость
правильная), но конкретный паттерн неконтролируем.
"""

from __future__ import annotations

import math
import random
from typing import Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

CELL = 64


# ─── Базовые цвета (минимум и максимум диапазона) ───────────────────────

# Светлая клетка: средний серый ∈ [170..240], тёмная: ∈ [40..130].
# Hue свободно, чтобы модель не цеплялась к конкретному оттенку.

def _sample_base_rgb(bg_kind: str, rng: random.Random) -> Tuple[int, int, int]:
    if bg_kind == "light":
        v = rng.randint(170, 240)
    else:
        v = rng.randint(40, 130)
    tint = rng.randint(-25, 25)
    r = max(0, min(255, v + rng.randint(-15, 15)))
    g = max(0, min(255, v + rng.randint(-15, 15)))
    b = max(0, min(255, v + tint))
    return r, g, b


def _contrast_rgb(base_rgb: Tuple[int, int, int], rng: random.Random,
                  intensity: float = 0.5) -> Tuple[int, int, int]:
    """Цвет штриха/точки/градиента — контрастный к base."""
    r, g, b = base_rgb
    avg = (r + g + b) / 3
    # На светлой базе делаем штрих темнее, на тёмной — светлее.
    if avg > 128:
        delta = -int(rng.uniform(60, 140) * intensity)
    else:
        delta = int(rng.uniform(60, 140) * intensity)
    return (
        max(0, min(255, r + delta)),
        max(0, min(255, g + delta)),
        max(0, min(255, b + delta)),
    )


# ─── solid ──────────────────────────────────────────────────────────────

def _bg_solid(bg_kind: str, rng: random.Random) -> Image.Image:
    return Image.new("RGB", (CELL, CELL), _sample_base_rgb(bg_kind, rng))


# ─── hatch (штриховка как в учебниках) ──────────────────────────────────

def _bg_hatch(bg_kind: str, rng: random.Random) -> Image.Image:
    base = _sample_base_rgb(bg_kind, rng)
    img = Image.new("RGB", (CELL, CELL), base)
    draw = ImageDraw.Draw(img)

    # Параметры штриховки.
    style = rng.choice(["diag1", "diag2", "cross", "horiz", "vert"])
    step = rng.randint(3, 9)              # расстояние между линиями
    width = rng.randint(1, 2)
    ink = _contrast_rgb(base, rng, intensity=rng.uniform(0.4, 1.0))

    def _diag(direction: int):
        # direction +1 — наклон ╱, -1 — ╲
        for offset in range(-CELL, CELL * 2, step):
            if direction > 0:
                p1 = (offset, 0)
                p2 = (offset + CELL, CELL)
            else:
                p1 = (offset, CELL)
                p2 = (offset + CELL, 0)
            draw.line([p1, p2], fill=ink, width=width)

    if style == "diag1":
        _diag(+1)
    elif style == "diag2":
        _diag(-1)
    elif style == "cross":
        _diag(+1)
        _diag(-1)
    elif style == "horiz":
        for y in range(0, CELL, step):
            draw.line([(0, y), (CELL, y)], fill=ink, width=width)
    elif style == "vert":
        for x in range(0, CELL, step):
            draw.line([(x, 0), (x, CELL)], fill=ink, width=width)
    return img


# ─── dots (точечный паттерн) ────────────────────────────────────────────

def _bg_dots(bg_kind: str, rng: random.Random) -> Image.Image:
    base = _sample_base_rgb(bg_kind, rng)
    img = Image.new("RGB", (CELL, CELL), base)
    draw = ImageDraw.Draw(img)
    ink = _contrast_rgb(base, rng, intensity=rng.uniform(0.3, 0.9))
    step = rng.randint(4, 10)
    radius = rng.uniform(0.6, 1.8)
    jitter = rng.uniform(0, step * 0.4)
    for y in range(step // 2, CELL, step):
        for x in range(step // 2, CELL, step):
            jx = x + rng.uniform(-jitter, jitter)
            jy = y + rng.uniform(-jitter, jitter)
            draw.ellipse(
                [(jx - radius, jy - radius), (jx + radius, jy + radius)],
                fill=ink,
            )
    return img


# ─── perlin-like noise (через смешивание blur'ов случайного шума) ───────

def _bg_perlin(bg_kind: str, rng: random.Random) -> Image.Image:
    base = _sample_base_rgb(bg_kind, rng)
    base_arr = np.full((CELL, CELL, 3), base, dtype=np.float32)
    # Смешиваем 2-3 октавы blur'нутого шума разной частоты.
    octaves = rng.randint(2, 3)
    noise = np.zeros((CELL, CELL), dtype=np.float32)
    seed = rng.randint(0, 2**31 - 1)
    np_rng = np.random.default_rng(seed)
    for o in range(octaves):
        scale = 2 ** (o + 1)  # 2, 4, 8 — частота
        # Сэмплим маленькое поле и апскейлим до 64.
        sm = np_rng.normal(0, 1, size=(CELL // scale + 1, CELL // scale + 1))
        sm_img = Image.fromarray(((sm - sm.min()) / (sm.ptp() + 1e-6) * 255).astype(np.uint8))
        sm_up = sm_img.resize((CELL, CELL), Image.BILINEAR)
        noise += np.asarray(sm_up, dtype=np.float32) / (255.0 * octaves)
    # Размах амплитуды шума.
    amp = rng.uniform(20, 60)
    delta = (noise - 0.5) * 2 * amp
    out = base_arr + delta[..., None]
    out = np.clip(out, 0, 255).astype(np.uint8)
    return Image.fromarray(out, mode="RGB")


# ─── gradient ───────────────────────────────────────────────────────────

def _bg_gradient(bg_kind: str, rng: random.Random) -> Image.Image:
    c1 = _sample_base_rgb(bg_kind, rng)
    c2 = _sample_base_rgb(bg_kind, rng)
    # Случайный угол.
    angle = rng.uniform(0, 2 * math.pi)
    dx, dy = math.cos(angle), math.sin(angle)
    xs = np.arange(CELL)[None, :].repeat(CELL, axis=0)
    ys = np.arange(CELL)[:, None].repeat(CELL, axis=1)
    proj = xs * dx + ys * dy
    proj = (proj - proj.min()) / (proj.ptp() + 1e-6)  # [0..1]
    arr = (
        np.array(c1, dtype=np.float32)[None, None, :] * (1 - proj)[..., None]
        + np.array(c2, dtype=np.float32)[None, None, :] * proj[..., None]
    )
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")


# ─── noise overlay ──────────────────────────────────────────────────────

def _bg_noise(bg_kind: str, rng: random.Random) -> Image.Image:
    base = _sample_base_rgb(bg_kind, rng)
    base_arr = np.full((CELL, CELL, 3), base, dtype=np.float32)
    sigma = rng.uniform(10, 35)
    np_rng = np.random.default_rng(rng.randint(0, 2**31 - 1))
    noise = np_rng.normal(0, sigma, size=(CELL, CELL, 3))
    out = np.clip(base_arr + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(out, mode="RGB")


# ─── Диспетчер ──────────────────────────────────────────────────────────

# Вероятности подобраны так, чтобы:
# - solid сохранял минимальное представительство (~20%, чтобы не сломать
#   текущий контракт сплошных фонов lichess/chess.com);
# - hatch был представлен заметно (учебники + любые «прозрачные» фоны);
# - остальное равномерно покрывало текстурные out-of-distribution случаи.

_BG_DISPATCH = [
    ("solid",    0.20, _bg_solid),
    ("hatch",    0.25, _bg_hatch),
    ("dots",     0.15, _bg_dots),
    ("perlin",   0.15, _bg_perlin),
    ("gradient", 0.10, _bg_gradient),
    ("noise",    0.15, _bg_noise),
]
_BG_TOTAL = sum(w for _, w, _ in _BG_DISPATCH)
assert abs(_BG_TOTAL - 1.0) < 1e-6, f"bg weights must sum to 1.0, got {_BG_TOTAL}"


def render_background(bg_kind: str, rng: random.Random) -> Image.Image:
    """Сгенерировать один фон клетки.

    `bg_kind` — "light" / "dark". Влияет на среднюю яркость, но конкретный
    паттерн (сплошной / штрих / шум / градиент) рандомизируется.
    """
    if bg_kind not in ("light", "dark"):
        raise ValueError(f"bg_kind must be 'light' or 'dark', got {bg_kind!r}")
    pick = rng.random()
    cum = 0.0
    for _name, w, fn in _BG_DISPATCH:
        cum += w
        if pick < cum:
            img = fn(bg_kind, rng)
            # Небольшой шанс blur'а поверх — имитация рендера/сжатия.
            if rng.random() < 0.15:
                img = img.filter(ImageFilter.GaussianBlur(radius=rng.uniform(0.3, 0.9)))
            return img
    # Падение в последний (теоретически недостижимо).
    return _BG_DISPATCH[-1][2](bg_kind, rng)


def list_bg_kinds() -> list:
    """Список имён доступных bg-генераторов (для preview-grid)."""
    return [name for name, _, _ in _BG_DISPATCH]
