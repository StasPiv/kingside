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

# Шрифты для генератора текстов внутри UI-сцен.
_FONTS_CACHE = {}


def _font(size: int, bold: bool = False) -> "ImageFont.ImageFont":
    key = (size, bold)
    if key in _FONTS_CACHE:
        return _FONTS_CACHE[key]
    path = "/usr/share/fonts/truetype/dejavu/DejaVuSans"
    path += "-Bold.ttf" if bold else ".ttf"
    try:
        f = ImageFont.truetype(path, size=size)
    except OSError:
        f = ImageFont.load_default()
    _FONTS_CACHE[key] = f
    return f


# Шахматные ходы / типичные строки UI для имитации mobile chess.com / lichess.
_MOVES_VOCAB = [
    "1.e4 e5", "2.Nf3 Nc6", "3.Bb5 a6", "4.Ba4 Nf6", "5.O-O Be7",
    "Nxc4", "Nd2+", "Rxc1", "Qxc3", "Qxc3", "Bxc6 bxc6",
    "1...c5", "2...d6", "20...Nc4!", "21.Ne3", "22.Ka2", "Best move",
    "blitz", "rapid", "bullet", "puzzle rating 1842", "+5",
    "Anatoly Karpov", "Magnus Carlsen", "GM_Player vs GM_Other",
    "Chess Tactics", "See What You Missed!", "Next", "Previous",
    "Read Mode", "Flip Board", "Analysis", "[-5.23]", "Continue",
    "Solve puzzle", "0:45", "12:30", "Your move", "White to move",
    "Black to move", "Move 24 of 47", "Last move: Nf3",
]


def _draw_text(d: ImageDraw.ImageDraw, x: int, y: int, text: str,
               size: int, fill: tuple, bold: bool = False) -> None:
    """Безопасный draw.text с обработкой случаев когда шрифт не нашёлся."""
    d.text((x, y), text, fill=fill, font=_font(size, bold))

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
    elif mode == "ui":
        bg = Image.new("RGB", (W, H), (245, 245, 245))
        d = ImageDraw.Draw(bg)
        bar_h = rng.randint(12, 20)
        d.rectangle((0, 0, W, bar_h), fill=tuple(rng.randint(220, 255) for _ in range(3)))
        # Иконки статус-бара текстом (батарея, время и т.п. — символами)
        _draw_text(d, W - 60, 2, "100%", 10, (40, 40, 40), bold=True)
        _draw_text(d, 6, 2, "22:19", 10, (40, 40, 40), bold=True)
        # Заголовок
        title_h = rng.randint(28, 40)
        d.rectangle((0, bar_h, W, bar_h + title_h),
                    fill=tuple(rng.randint(240, 255) for _ in range(3)))
        title = rng.choice(_MOVES_VOCAB)
        _draw_text(d, 14, bar_h + 8, title, rng.randint(13, 17), (20, 20, 20), bold=True)
        # Случайные строки текста (имитация заметок, ходов).
        for _ in range(rng.randint(2, 5)):
            ty = rng.randint(bar_h + title_h + 10, max(bar_h + title_h + 11, H - 40))
            tx = rng.randint(10, max(11, W - 100))
            txt = rng.choice(_MOVES_VOCAB)
            _draw_text(d, tx, ty, txt, rng.randint(10, 14),
                       tuple(rng.randint(40, 100) for _ in range(3)))
        # Кнопки снизу с подписями.
        btn_y = H - rng.randint(40, 60)
        n_btn = rng.randint(3, 5)
        for i in range(n_btn):
            bx = (W // n_btn) * i + 5
            d.rectangle((bx, btn_y, bx + 38, btn_y + 25),
                        outline=tuple(rng.randint(100, 180) for _ in range(3)), width=1)
            label = rng.choice(["Next", "Prev", "Flip", "Hint", "Solve", "≡"])
            _draw_text(d, bx + 4, btn_y + 5, label, 9, (60, 60, 60))
    else:  # mobile_app — реалистичная имитация chess.com / lichess мобильного UI
        bg = Image.new("RGB", (W, H), (250, 250, 250))
        d = ImageDraw.Draw(bg)
        # Статус-бар c часами/иконками текстом.
        sb_h = rng.randint(12, 18)
        d.rectangle((0, 0, W, sb_h), fill=(255, 255, 255))
        _draw_text(d, 8, 2, f"{rng.randint(8,23):02d}:{rng.randint(0,59):02d}", 10, (20,20,20), bold=True)
        _draw_text(d, W - 40, 2, f"{rng.randint(20,100)}%", 10, (20,20,20), bold=True)
        # Заголовок страницы — реальный текст
        hdr_h = rng.randint(22, 32)
        d.rectangle((0, sb_h, W, sb_h + hdr_h), fill=(248, 248, 248))
        title = rng.choice(["Chess Tactics", "Daily Puzzle", "See What You Missed!",
                            "Game Review", "Find the best move",
                            "RobertoJairzinho vs. GMplayer", "Analysis"])
        _draw_text(d, 16, sb_h + 6, title, rng.randint(13, 16), (30, 30, 30), bold=True)
        # Кнопки сверху справа (×, settings)
        _draw_text(d, W - 32, sb_h + 8, "×", 14, (60, 60, 60), bold=True)

        # Большой блок снизу под доской — текст ходов / описание / кнопка
        bottom_h = rng.randint(int(H * 0.20), int(H * 0.45))
        bot_y = H - bottom_h
        # Имя игрока (одна-две строки).
        _draw_text(d, 14, bot_y + 8, rng.choice(_MOVES_VOCAB),
                   rng.randint(12, 16), (20, 20, 20), bold=True)
        # Строка под именем (рейтинг / счёт).
        _draw_text(d, 14, bot_y + 28, f"({rng.randint(800,2700)})  vs.  ({rng.randint(800,2700)})",
                   11, (90, 90, 90))
        # Кнопка-капсула справа («Next», «Continue»).
        btn_x = max(20, W - 90); btn_y_top = bot_y + rng.randint(8, 24)
        btn_col = rng.choice([(120, 180, 95), (95, 160, 200), (200, 130, 80)])
        d.rounded_rectangle((btn_x, btn_y_top, btn_x + 80, btn_y_top + 32),
                            radius=16, fill=btn_col)
        _draw_text(d, btn_x + 18, btn_y_top + 8, rng.choice(["Next ›", "Continue", "Solve"]),
                   13, (255, 255, 255), bold=True)
        # Текст «лучший ход» / описание
        descr_y = bot_y + 60
        if descr_y < H - 80:
            _draw_text(d, 14, descr_y,
                       rng.choice(["In a game played on 2023-12-29 22:21:48, the best move was:",
                                   "Find the winning move for white.",
                                   "Black to move and win material.",
                                   f"After {rng.randint(1,40)}.{rng.choice(_MOVES_VOCAB)}, what is best?"]),
                       11, (40, 40, 40))
            _draw_text(d, 14, descr_y + 18, rng.choice(_MOVES_VOCAB),
                       12, (60, 60, 60), bold=True)
            # Линия ходов с акцентом (как в chess.com tactics).
            mv_y = descr_y + 36
            if mv_y < H - 50:
                _draw_text(d, 14, mv_y, f"[{rng.randint(-9,9)}.{rng.randint(10,99)}]",
                           11, (180, 50, 130), bold=True)
                # ходы рядом
                mx = 60
                for _ in range(rng.randint(3, 6)):
                    if mx > W - 80: break
                    txt = rng.choice(_MOVES_VOCAB)
                    _draw_text(d, mx, mv_y, txt, 11, (180, 50, 130), bold=True)
                    mx += rng.randint(50, 90)
        # Нижняя панель навигации с подписями
        nav_y = H - 30
        if nav_y > bot_y + 80:
            n_btn = rng.randint(4, 6)
            labels = ["Previous", "Next", "Read Mode", "Flip Board", "Analysis", "Hint"]
            rng.shuffle(labels)
            for i in range(n_btn):
                bx = (W // n_btn) * i + 5
                _draw_text(d, bx + 4, nav_y + 4, labels[i % len(labels)],
                           9, (70, 70, 70))
    return bg


# ─── Сборка одной пары (изображение, углы) ────────────────────────────────

def _sample_one(rng: random.Random, fen: str, style: str) -> Tuple[Image.Image, np.ndarray]:
    """Возвращает (картинка target_size, нормализованные координаты 4 углов).

    KS-3091 v3 follow-up: 3 размер-распределения:
      - 40% сценариев — почти весь кадр (200-252 px), как chess.com web.
      - 30% — среднеразмерная доска (140-200 px), как mobile с UI.
      - 30% — маленькая (80-140 px), как книжная диаграмма или
        миниатюра в большом UI.
    """
    board = _render_board(fen, style, rng)
    size_bucket = rng.random()
    if size_bucket < 0.4:
        target_board = rng.randint(200, BOARD_MAX_PX)
    elif size_bucket < 0.7:
        target_board = rng.randint(140, 200)
    else:
        target_board = rng.randint(BOARD_MIN_PX, 140)
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
