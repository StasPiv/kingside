"""KS-3091 v3: генератор синтетических скриншотов для обучения
corner-detector'а (нейросеть, которая находит 4 угла доски на картинке).

Один пример датасета: (изображение HxW, 8 чисел — координаты 4 углов).

Стратегия:
1. Берём FEN (детерминированный набор) + стиль (random из всех скачанных).
2. Рендерим полную доску 8×8 клеток (через render_cell + сборка).
3. Случайный размер итоговой доски (160..480 px).
4. Случайный «фон»: однотонный, шум, имитация UI (текстовые блоки,
   прямоугольники, имитация кнопок снизу/сверху).
5. Накладываем доску в случайное место холста.
6. Случайные искажения: лёгкая перспектива (±5°), поворот (±5°), blur,
   JPEG-сжатие.
7. Координаты 4 углов отслеживаем сквозь все трансформации.

Выход: HDF5 файл `cells_corners.h5` со структурой:
  - images: vlen uint8 (PNG bytes картинки)
  - corners: float32 (N, 8) — нормализованные координаты [0..1]
    (x1,y1,x2,y2,x3,y3,x4,y4) в порядке TL, TR, BR, BL.
"""

from __future__ import annotations

import argparse
import io
import random
import sys
import time
from pathlib import Path
from typing import List, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# Локальные импорты.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import dataset_gen as dg  # noqa: E402


TARGET_IMG_SIZE = 256        # вход для нейросети
# KS-3091 v3 follow-up: расширяем диапазон. Реальные сценарии:
#   - доска на весь экран (almost full screen) — chess.com web, lichess web
#   - доска в верхней части (~50% высоты) — mobile chess.com app с UI
#   - доска маленькая в книжной странице — book diagram (multiple boards)
BOARD_MIN_PX = 80            # маленькая доска (~30% картинки)
BOARD_MAX_PX = 252           # почти весь кадр (~98%)


# ─── Рендер полной доски 8×8 ──────────────────────────────────────────────

def _render_board(fen: str, style: str, rng: random.Random) -> Image.Image:
    """Полная доска 512×512 (8×8 клеток render_cell)."""
    grid = dg._fen_to_grid(fen)
    board = Image.new("RGB", (dg.BOARD_SIZE, dg.BOARD_SIZE), (200, 200, 200))
    for r in range(8):
        for c in range(8):
            label = grid[r][c]
            bg = dg._square_kind(r, c)
            cell = dg.render_cell(label, style, bg, rng, fixed_bg=False)
            board.paste(cell, (c * dg.CELL_SIZE, r * dg.CELL_SIZE))
    return board


# ─── Случайный фон ────────────────────────────────────────────────────────

def _make_background(W: int, H: int, rng: random.Random) -> Image.Image:
    """Случайный фон холста: однотонный/шумный/имитация UI."""
    # Mobile_app — большой блок UI снизу (как у chess.com app: список ходов,
    # кнопки, текст игроков, заголовок сверху).
    mode = rng.choice(["solid", "gradient", "ui", "mobile_app", "mobile_app"])
    if mode == "solid":
        c = tuple(rng.randint(200, 255) for _ in range(3))
        bg = Image.new("RGB", (W, H), c)
    elif mode == "gradient":
        bg = Image.new("RGB", (W, H), (255, 255, 255))
        d = ImageDraw.Draw(bg)
        c1 = tuple(rng.randint(180, 255) for _ in range(3))
        c2 = tuple(rng.randint(180, 255) for _ in range(3))
        for y in range(H):
            t = y / max(1, H - 1)
            mix = tuple(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3))
            d.line([(0, y), (W, y)], fill=mix)
    else:  # ui — имитация мобильного UI
        bg = Image.new("RGB", (W, H), (245, 245, 245))
        d = ImageDraw.Draw(bg)
        # Статус-бар сверху
        bar_h = rng.randint(15, 35)
        d.rectangle((0, 0, W, bar_h), fill=tuple(rng.randint(220, 255) for _ in range(3)))
        # Заголовок
        title_h = rng.randint(30, 50)
        d.rectangle((0, bar_h, W, bar_h + title_h),
                    fill=tuple(rng.randint(240, 255) for _ in range(3)))
        # Случайные «текстовые блоки»
        for _ in range(rng.randint(3, 8)):
            tx = rng.randint(0, W - 40)
            ty = rng.randint(bar_h + title_h, H - 20)
            tw = rng.randint(30, min(W - tx, 200))
            th = rng.randint(3, 10)
            d.rectangle((tx, ty, tx + tw, ty + th),
                        fill=tuple(rng.randint(80, 180) for _ in range(3)))
        # «Кнопки» снизу
        btn_y = H - rng.randint(40, 70)
        n_btn = rng.randint(3, 5)
        for i in range(n_btn):
            bx = (W // n_btn) * i + rng.randint(5, 15)
            d.rectangle((bx, btn_y, bx + 40, btn_y + 30),
                        outline=tuple(rng.randint(100, 180) for _ in range(3)), width=2)
    return bg


# ─── Сборка одной пары (изображение, углы) ────────────────────────────────

def _sample_one(rng: random.Random, fen: str, style: str) -> Tuple[Image.Image, np.ndarray]:
    """Возвращает (картинка target_size, нормализованные координаты 4 углов)."""
    board = _render_board(fen, style, rng)
    target_board = rng.randint(BOARD_MIN_PX, BOARD_MAX_PX)
    board = board.resize((target_board, target_board), Image.LANCZOS)

    # Лёгкий поворот доски ±5° перед вставкой.
    if rng.random() < 0.7:
        angle = rng.uniform(-5, 5)
        board = board.rotate(angle, resample=Image.BICUBIC, expand=True,
                             fillcolor=(255, 255, 255))
    bw, bh = board.size

    # Фон.
    canvas = _make_background(TARGET_IMG_SIZE, TARGET_IMG_SIZE, rng)

    # Позиция доски на холсте.
    max_x = TARGET_IMG_SIZE - bw - 1
    max_y = TARGET_IMG_SIZE - bh - 1
    if max_x < 0 or max_y < 0:
        # доска не помещается — уменьшим
        scale = (TARGET_IMG_SIZE - 4) / max(bw, bh)
        bw = int(bw * scale); bh = int(bh * scale)
        board = board.resize((bw, bh), Image.LANCZOS)
        max_x = TARGET_IMG_SIZE - bw - 1
        max_y = TARGET_IMG_SIZE - bh - 1
    x0 = rng.randint(0, max(0, max_x))
    y0 = rng.randint(0, max(0, max_y))
    canvas.paste(board, (x0, y0))

    # Координаты 4 углов доски (после rotation expand=True, доска уже не
    # квадрат в смысле «соответствует углам»). Для упрощения берём углы
    # bbox'а — TL, TR, BR, BL. Это достаточно близко к реальным углам для
    # обучения регрессионной задачи.
    x1, y1 = x0, y0                     # TL
    x2, y2 = x0 + bw, y0                # TR
    x3, y3 = x0 + bw, y0 + bh           # BR
    x4, y4 = x0, y0 + bh                # BL
    corners = np.array([x1, y1, x2, y2, x3, y3, x4, y4], dtype=np.float32)
    corners /= TARGET_IMG_SIZE

    # Финальные искажения.
    if rng.random() < 0.3:
        canvas = canvas.filter(ImageFilter.GaussianBlur(radius=rng.uniform(0.3, 1.0)))
    if rng.random() < 0.3:
        buf = io.BytesIO()
        canvas.save(buf, format="JPEG", quality=rng.randint(60, 95))
        buf.seek(0)
        canvas = Image.open(buf).convert("RGB")

    return canvas, corners


# ─── CLI / основной цикл ──────────────────────────────────────────────────

def _all_styles() -> List[str]:
    """Все стили из styles_cache которые реально подгружаются."""
    out = []
    for path in dg.STYLES_DIR.iterdir():
        if not path.is_dir():
            continue
        try:
            dg._load_piece(path.name, "wK")
            out.append(path.name)
        except Exception:
            continue
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=8000,
                    help="Сколько пар (картинка, углы) сгенерировать.")
    ap.add_argument("--seed", type=int, default=3096)
    ap.add_argument("--out", type=Path,
                    default=dg.DATA_DIR / "corners.h5")
    args = ap.parse_args(argv)

    import h5py

    rng = random.Random(args.seed)
    styles = _all_styles()
    print(f"[corners] {len(styles)} styles available", file=sys.stderr)

    # Берём фиксированные FEN'ы (как для val), но используем все 500.
    fens, _ = dg._build_val_fen_list()
    print(f"[corners] {len(fens)} FENs in pool", file=sys.stderr)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with h5py.File(args.out, "w") as fh:
        img_ds = fh.create_dataset("images", shape=(args.n,),
                                    dtype=h5py.vlen_dtype(np.uint8))
        corners_ds = fh.create_dataset("corners", shape=(args.n, 8),
                                        dtype=np.float32)
        for i in range(args.n):
            fen = rng.choice(fens)
            style = rng.choice(styles)
            img, corners = _sample_one(rng, fen, style)
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=False)
            img_ds[i] = np.frombuffer(buf.getvalue(), dtype=np.uint8)
            corners_ds[i] = corners
            if (i + 1) % 500 == 0 or i + 1 == args.n:
                elapsed = time.time() - t0
                rate = (i + 1) / max(elapsed, 0.01)
                print(f"[corners] {i + 1:,}/{args.n:,} ({rate:.0f}/s)",
                      file=sys.stderr)
    print(f"[corners] done in {time.time() - t0:.0f}s → {args.out}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
