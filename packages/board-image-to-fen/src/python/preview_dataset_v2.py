#!/usr/bin/env python3
"""
KS-3091: визуальная превью-сетка v2-датасета для рецензии пользователем.

Генерирует два PNG:

  data/v2/preview/train_grid.png  — 13 классов × 9 train-стилей (один пример
                                    на ячейку) с подписями.
  data/v2/preview/val_grid.png    — 13 классов × 7 val-стилей.

Картинки нужны до прогона полного датасета — чтобы пользователь сразу видел,
что под классом "wK" в train действительно белый король в monarchy/tatiana/
caliente/etc., а в val — в cburnett/merida/wikipedia/alpha/staunty/pirouetti/
kingside_default.
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Локальные импорты dataset_gen.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import dataset_gen as dg  # noqa: E402

PREVIEW_DIR = dg.DATA_DIR / "preview"
TILE = dg.CELL_SIZE       # 64
PAD = 4
HEADER = 24
LABEL_W = 56


def _font() -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size=11,
        )
    except OSError:
        return ImageFont.load_default()


def _build_grid(styles, out_path: Path, title: str) -> None:
    rng = random.Random(42)
    n_classes = len(dg.LABELS)
    n_styles = len(styles)

    grid_w = LABEL_W + n_styles * (TILE + PAD) + PAD
    grid_h = HEADER + HEADER + n_classes * (TILE + PAD) + PAD
    canvas = Image.new("RGB", (grid_w, grid_h), (245, 245, 245))
    draw = ImageDraw.Draw(canvas)
    font = _font()

    # Заголовок
    draw.text((6, 4), title, fill=(20, 20, 20), font=font)

    # Header row: имена стилей
    for j, style in enumerate(styles):
        x = LABEL_W + j * (TILE + PAD)
        # Сокращаем "lichess_" чтобы влезло.
        short = style.replace("lichess_", "")
        draw.text(
            (x + 2, HEADER + 4),
            short[:9],
            fill=(40, 40, 40), font=font,
        )

    # Каждая строка — класс. Каждая колонка — стиль.
    for i, label in enumerate(dg.LABELS):
        y = HEADER * 2 + i * (TILE + PAD)
        draw.text((4, y + TILE // 2 - 6), label, fill=(20, 20, 20), font=font)
        for j, style in enumerate(styles):
            x = LABEL_W + j * (TILE + PAD)
            # bg: light для чётных, dark для нечётных — даёт визуальное чередование.
            bg_kind = "light" if (i + j) % 2 == 0 else "dark"
            try:
                cell = dg.render_cell(label, style, bg_kind, rng)
                canvas.paste(cell, (x, y))
            except Exception as exc:  # noqa: BLE001
                draw.rectangle(
                    (x, y, x + TILE, y + TILE), fill=(220, 50, 50),
                )
                draw.text((x + 2, y + 2), f"err\n{exc}"[:24],
                          fill=(255, 255, 255), font=font)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, format="PNG")
    print(f"[preview] wrote {out_path} ({canvas.size[0]}×{canvas.size[1]})", file=sys.stderr)


def main() -> int:
    _build_grid(
        dg.TRAIN_STYLES, PREVIEW_DIR / "train_grid.png",
        "v2 TRAIN preview — 13 classes × 9 styles (chess-expert KS-3091)",
    )
    _build_grid(
        dg.VAL_STYLES, PREVIEW_DIR / "val_grid.png",
        "v2 VAL (held-out) preview — 13 classes × 7 target styles",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
