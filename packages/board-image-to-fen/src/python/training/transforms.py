"""KS-3091 / ADR-040-v2 §1.1. Albumentations-трансформации, вынесены
в отдельный модуль от `dataset.py` чтобы не тянуть torch при сборке
визуальных превью (preview_augmented_v2.py). `dataset.py` импортирует
функции отсюда для обратной совместимости.
"""

from __future__ import annotations


def build_train_transform(cell_size: int = 64):
    """Augmentations used during training.

    KS-3091 / ADR-040-v2 §1.1 — расширенный pipeline. Старый v1-набор был
    слишком мягкий («the dataset is already synthetically diverse») — в
    итоге модель не научилась обобщать. v2 датасет принципиально другой:
    train на 9 чужих piece-set'ах, val на 7 целевых. Сильная аугментация
    нужна именно для того, чтобы модель не запоминала спрайт, а учила
    силуэт.

    Применяется ПОСЛЕ class-sampling в dataset_gen.py (chess-expert §4:
    иначе один и тот же augmented tile попадает в батч N раз при
    oversample редких классов).

    Pipeline (по ADR-040-v2 §1.1):
      Geometry  — Affine ± translate/scale/rotate; Perspective (distort
                  0.04–0.08).
      Color     — HueSaturationValue ±20/±30/±20, RGBShift ±20,
                  RandomBrightnessContrast.
      Render    — Downscale 0.5–0.9 (имитация warp-в-low-res),
                  ImageCompression(quality_lower=50), Sharpen со случайным α.
      Noise     — GaussNoise.
    """
    import albumentations as A
    import cv2  # used below for explicit BORDER_CONSTANT
    from albumentations.pytorch import ToTensorV2

    return A.Compose([
        A.LongestMaxSize(max_size=cell_size),
        A.PadIfNeeded(
            min_height=cell_size,
            min_width=cell_size,
            border_mode=cv2.BORDER_CONSTANT,
            value=0,
        ),
        # KS-3091 v3 follow-up: переводим в grayscale ВСЕГДА — модель учится
        # форме фигуры, не цвету фона. ToGray даёт grayscale в 3-канальном
        # представлении (R=G=B), что совместимо с MobileNetV3 на 3 входа.
        A.ToGray(p=1.0),
        # ── Геометрия ──────────────────────────────────────────────────
        A.Affine(
            translate_percent={"x": (-0.06, 0.06), "y": (-0.06, 0.06)},
            scale=(0.92, 1.08),
            rotate=(-4, 4),
            p=0.7,
        ),
        A.Perspective(scale=(0.04, 0.08), keep_size=True, p=0.4),
        # ── Яркость/контраст (цветовая аугментация убрана — grayscale) ─
        A.RandomBrightnessContrast(
            brightness_limit=0.20, contrast_limit=0.20, p=0.5,
        ),
        # ── Имитация рендер-артефактов прода ───────────────────────────
        A.Downscale(scale_min=0.5, scale_max=0.9, p=0.3),
        A.ImageCompression(quality_lower=50, quality_upper=100, p=0.4),
        A.Sharpen(alpha=(0.0, 0.5), lightness=(0.8, 1.2), p=0.2),
        # ── Шум ────────────────────────────────────────────────────────
        A.GaussNoise(var_limit=(5.0, 25.0), p=0.2),
        A.Normalize(
            mean=(0.485, 0.456, 0.406),
            std=(0.229, 0.224, 0.225),
        ),
        ToTensorV2(),
    ])


def build_preview_pipeline(cell_size: int = 64):
    """Тот же набор шагов что `build_train_transform`, без финальных
    `Normalize` + `ToTensorV2` (они нужны только модели). Возвращает
    numpy-массив HxWx3 uint8 → удобно сразу класть в визуальный grid.

    Используется `preview_augmented_v2.py` для аудита: пользователь видит
    «как клетку искажает аугментация» без необходимости тянуть torch
    в окружение превью.
    """
    import albumentations as A
    import cv2

    return A.Compose([
        A.LongestMaxSize(max_size=cell_size),
        A.PadIfNeeded(
            min_height=cell_size,
            min_width=cell_size,
            border_mode=cv2.BORDER_CONSTANT,
            value=0,
        ),
        A.Affine(
            translate_percent={"x": (-0.06, 0.06), "y": (-0.06, 0.06)},
            scale=(0.92, 1.08),
            rotate=(-4, 4),
            p=0.7,
        ),
        A.Perspective(scale=(0.04, 0.08), keep_size=True, p=0.4),
        A.RandomBrightnessContrast(
            brightness_limit=0.20, contrast_limit=0.20, p=0.5,
        ),
        A.HueSaturationValue(
            hue_shift_limit=20, sat_shift_limit=30, val_shift_limit=20, p=0.5,
        ),
        A.RGBShift(
            r_shift_limit=20, g_shift_limit=20, b_shift_limit=20, p=0.4,
        ),
        A.Downscale(scale_min=0.5, scale_max=0.9, p=0.3),
        A.ImageCompression(quality_lower=50, quality_upper=100, p=0.4),
        A.Sharpen(alpha=(0.0, 0.5), lightness=(0.8, 1.2), p=0.2),
        A.GaussNoise(var_limit=(5.0, 25.0), p=0.2),
        # NO Normalize, NO ToTensorV2 — превью.
    ])


def build_eval_transform(cell_size: int = 64):
    """No augmentation, just grayscale + resize + normalize.

    KS-3091 v3 follow-up: ToGray на eval/inference — модель ожидает
    grayscale-вход, как на train.
    """
    import albumentations as A
    import cv2
    from albumentations.pytorch import ToTensorV2

    return A.Compose([
        A.LongestMaxSize(max_size=cell_size),
        A.PadIfNeeded(
            min_height=cell_size,
            min_width=cell_size,
            border_mode=cv2.BORDER_CONSTANT,
            value=0,
        ),
        A.ToGray(p=1.0),
        A.Normalize(
            mean=(0.485, 0.456, 0.406),
            std=(0.229, 0.224, 0.225),
        ),
        ToTensorV2(),
    ])
