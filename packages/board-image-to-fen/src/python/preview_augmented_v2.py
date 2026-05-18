#!/usr/bin/env python3
"""KS-3091: визуальный аудит Albumentations-аугментации, которая
применяется на лету во время тренировки модели.

Зачем
-----
Пользователь не видит «промежуточный» вариант — между сгенерированной
клеткой и тем, что попадёт в модель, в момент чтения из HDF5 применяется
`training/dataset.py:build_train_transform()`. Этот скрипт показывает,
как именно искажается клетка: оригинал + 6 случайных проходов pipeline.

Контракт
--------
Импортирует РОВНО тот же `build_train_transform` что и тренировка
(этап C/D). Если аугментацию поменяют — этот превью отразит изменение
без дополнительных правок.

Выход
-----
data/v2/preview/augmented_grid.png — grid 13 строк × 7 колонок:
    колонка 0 — оригинал клетки (как лежит в HDF5);
    колонки 1..6 — augmented варианты (разные seed'ы).
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "training"))

import dataset_gen as dg  # noqa: E402
# build_preview_pipeline — тот же набор Albumentations-шагов что и у
# `build_train_transform` в тренировке, БЕЗ финальных Normalize+ToTensorV2
# (они нужны только модели). Это даёт визуальный аудит без torch.
from training.transforms import build_preview_pipeline  # noqa: E402

PREVIEW_DIR = dg.DATA_DIR / "preview"
TILE = dg.CELL_SIZE
PAD = 4
HEADER = 24
LABEL_W = 56
N_AUG_VARIANTS = 6


def _font() -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size=11,
        )
    except OSError:
        return ImageFont.load_default()


def build_augmented_grid(out_path: Path) -> None:
    """13 классов × (1 original + 6 augmented) клеток."""
    transform = build_preview_pipeline(cell_size=dg.CELL_SIZE)
    base_rng = random.Random(2026)

    n_rows = len(dg.LABELS)
    n_cols = 1 + N_AUG_VARIANTS

    grid_w = LABEL_W + n_cols * (TILE + PAD) + PAD
    grid_h = HEADER + HEADER + n_rows * (TILE + PAD) + PAD
    canvas = Image.new("RGB", (grid_w, grid_h), (245, 245, 245))
    draw = ImageDraw.Draw(canvas)
    font = _font()

    draw.text(
        (6, 4),
        "v2 augmented preview — original + 6 augmented variants (Perspective + HSV + RGBShift + Downscale + JPEG + Sharpen + Noise)",
        fill=(20, 20, 20), font=font,
    )

    # Header
    header_labels = ["original"] + [f"aug #{i + 1}" for i in range(N_AUG_VARIANTS)]
    for j, lbl in enumerate(header_labels):
        x = LABEL_W + j * (TILE + PAD)
        draw.text((x + 2, HEADER + 4), lbl, fill=(40, 40, 40), font=font)

    for i, label in enumerate(dg.LABELS):
        y = HEADER * 2 + i * (TILE + PAD)
        draw.text((4, y + TILE // 2 - 6), label, fill=(20, 20, 20), font=font)

        # Базовая клетка: один и тот же стиль на строку (тривиально воспроизводимо).
        style = dg.TRAIN_STYLES[i % len(dg.TRAIN_STYLES)]
        bg_kind = "light" if i % 2 == 0 else "dark"
        base_cell = dg.render_cell(label, style, bg_kind, base_rng)

        # Column 0: original.
        canvas.paste(base_cell, (LABEL_W, y))

        # Columns 1..N: augmented.
        np_img = np.asarray(base_cell, dtype=np.uint8)
        for k in range(N_AUG_VARIANTS):
            # Каждый раз новый seed, чтобы трансформации различались.
            seed = 1000 * i + k + 1
            random.seed(seed)
            np.random.seed(seed)
            out = transform(image=np_img)
            arr = out["image"]  # HxWx3 uint8 (no Normalize/ToTensor)
            aug_img = Image.fromarray(arr, mode="RGB")
            if aug_img.size != (TILE, TILE):
                aug_img = aug_img.resize((TILE, TILE), Image.NEAREST)
            x = LABEL_W + (1 + k) * (TILE + PAD)
            canvas.paste(aug_img, (x, y))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, format="PNG")
    print(f"[preview] wrote {out_path} ({canvas.size[0]}×{canvas.size[1]})", file=sys.stderr)


def main() -> int:
    build_augmented_grid(PREVIEW_DIR / "augmented_grid.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
