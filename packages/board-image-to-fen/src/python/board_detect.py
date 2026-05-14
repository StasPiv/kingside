#!/usr/bin/env python3
"""KS-2359 / ADR-040 Stage 1. Детекция шахматной доски из произвольного
изображения и приведение её к канонической квадратной форме 512×512.

Это вход pipeline'а universal board recognition:

    image (PNG/JPG, ≤ 8 MB)
        ↓
    [Stage 1: board detection]  ← этот файл
        ↓
    warped 512×512 (без полей, без рамки)
        ↓
    [Stage 2: cell classification]  ← KS-2361
        ↓
    [Stage 3: FEN assembly]  ← KS-2362

В отличие от `recognizer.py` (KS-2028), который работает по шаблонам
шрифта Майзелиса, этот файл — универсальный геометрический детектор:
ему всё равно, какие фигуры на доске, нужна только геометрия квадрата
8×8.

## Алгоритм (с fallback'ом)

1. **OpenCV heuristics** (быстрая ветка, ~95% всех скриншотов):
   - Grayscale + bilateral filter (сохраняет края, гасит шум фона).
   - `cv2.Canny` для edge detection с auto-thresholds.
   - `cv2.findContours` → `cv2.approxPolyDP` + фильтр convex 4-poly.
   - Среди кандидатов берём наибольший по площади с aspect ≈ 1
     (квадратность ≤ 15%).
   - Если контур не найден — fallback на Hough lines + пересечения.
2. **UNet fallback** (для сложных случаев: фото с углом, низкий
   контраст, доска без рамки). Hook-функция `detect_with_unet`,
   которая берёт ONNX-модель из `--unet-model`. Если модель не передана
   или не существует — graceful skip, возвращаем результат OpenCV-ветки.

   Модель будет обучена в KS-2361 (Stage 2 классификатор тренируется
   на том же датасете). Текущая реализация — заглушка с правильным
   интерфейсом.

## Использование

CLI:
    python3 board_detect.py <image-path> [--out warped.png]
                                          [--unet-model model.onnx]
                                          [--json]

Без `--json`: выводит «success=true/false method=<opencv|unet|failed>
confidence=X corners=...» в stdout, ошибки в stderr.

С `--json`: выводит JSON-объект с полями `success`, `method`, `corners`,
`confidence`, `image_size`. Если `--out` задан и `success=true`,
warped 512×512 сохраняется в файл.

Python API:
    from board_detect import detect_board
    result = detect_board('screenshot.png', unet_model_path=None)
    # result == {'success': True, 'method': 'opencv', 'corners': [...],
    #            'confidence': 0.85, 'image_size': [W, H]}
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import List, Optional, Tuple

import cv2
import numpy as np


# ─── Константы ────────────────────────────────────────────────────────

#: Размер канонической квадратной доски на выходе Stage 1.
WARP_SIZE = 512

#: Минимальная площадь кандидата-четырёхугольника, как доля от
#: площади всего изображения. Меньше — отсекаем (мелкие объекты).
MIN_AREA_FRACTION = 0.05

#: Максимальная площадь — отсекаем кандидата, который — почти всё
#: изображение (рамка окна, не доска).
MAX_AREA_FRACTION = 0.98

#: Терпимость к отклонению от квадрата (aspect ratio). Доска ≈ 1.0;
#: при наклоне 30° — ratio bbox'а может уйти до 1.3. Берём 1.5 для
#: запаса (perspective warp выправит).
MAX_ASPECT_DEVIATION = 0.5  # 1.0±0.5 = [0.5, 1.5]

#: Доля периметра для `approxPolyDP`. 0.02 — стандартное значение для
#: нахождения 4-угольников с допустимой кривизной.
APPROX_POLY_EPS_FRACTION = 0.02


# ─── Публичный API ────────────────────────────────────────────────────


def detect_board(
    image_path: str,
    unet_model_path: Optional[str] = None,
) -> dict:
    """Детектит доску на изображении и возвращает результат.

    Args:
        image_path: путь к изображению (PNG/JPG/BMP).
        unet_model_path: путь к ONNX-модели UNet для fallback на сложных
            случаях. Если `None` или файл не существует — fallback
            пропускается (graceful skip).

    Returns:
        dict с полями:
            success: bool — детекция прошла.
            method: 'opencv' | 'unet' | 'failed'.
            corners: list[[x, y]] длины 4 в порядке TL, TR, BR, BL,
                либо `None` при failed.
            confidence: float [0..1] — эвристическая оценка.
            image_size: [W, H] исходного изображения.
            warped: ndarray (512, 512, 3) — каноническая доска,
                либо `None` при failed. Для CLI сохраняется в `--out`.
    """
    image = _read_image(image_path)
    if image is None:
        return {
            'success': False,
            'method': 'failed',
            'corners': None,
            'confidence': 0.0,
            'image_size': None,
            'warped': None,
            'error': f'cannot read image: {image_path}',
        }
    return _detect_board_array(image, unet_model_path=unet_model_path)


def _read_image(image_path: str) -> Optional[np.ndarray]:
    """Загружает изображение в BGR numpy-массив. `cv2.imread` не
    поддерживает GIF и SVG — для них (и как general fallback) идём
    через Pillow."""
    img = cv2.imread(image_path)
    if img is not None:
        return img
    try:
        from PIL import Image  # lazy: Pillow только если cv2.imread не справился.

        with Image.open(image_path) as pil_img:
            pil_img = pil_img.convert('RGB')
            arr = np.array(pil_img)
        # PIL даёт RGB; OpenCV ждёт BGR.
        return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    except Exception:  # noqa: BLE001
        return None


def _detect_board_array(
    image: np.ndarray,
    unet_model_path: Optional[str] = None,
) -> dict:
    """Внутренний вход: принимает уже загруженный BGR-массив."""
    h, w = image.shape[:2]

    # 1. OpenCV-ветка.
    corners, confidence = _detect_opencv(image)
    method = 'opencv'

    # 2. UNet fallback — если OpenCV не нашёл или уверенность низкая.
    if corners is None or confidence < 0.5:
        unet_corners, unet_confidence = _detect_with_unet_safe(
            image, unet_model_path
        )
        if unet_corners is not None and unet_confidence > (confidence or 0):
            corners = unet_corners
            confidence = unet_confidence
            method = 'unet'

    if corners is None:
        return {
            'success': False,
            'method': 'failed',
            'corners': None,
            'confidence': 0.0,
            'image_size': [w, h],
            'warped': None,
        }

    # 3. Perspective warp в 512×512.
    warped = _warp_to_square(image, corners, WARP_SIZE)

    return {
        'success': True,
        'method': method,
        'corners': [[int(c[0]), int(c[1])] for c in corners],
        'confidence': float(confidence),
        'image_size': [w, h],
        'warped': warped,
    }


# ─── OpenCV ветка ────────────────────────────────────────────────────


def _detect_opencv(
    image: np.ndarray,
) -> Tuple[Optional[np.ndarray], float]:
    """Heuristic-детекция через Canny + findContours + approxPolyDP.

    Возвращает (corners_TL_TR_BR_BL, confidence) либо (None, 0.0).
    """
    h, w = image.shape[:2]
    total_area = h * w

    # 1. Серое + сглаживание. Bilateral сохраняет края — лучше чем
    # GaussianBlur для дальнейшего Canny.
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    smoothed = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)

    # 2. Auto-thresholds для Canny через median (как у Lichess
    # board-detection): t1 = max(0, 0.66*median), t2 = min(255, 1.33*median).
    # Это устойчивее к разной освещённости/контрасту чем фикс. 50/150.
    median = float(np.median(smoothed))
    lower = int(max(0, 0.66 * median))
    upper = int(min(255, 1.33 * median))
    edges = cv2.Canny(smoothed, lower, upper)

    # 3. Закрываем мелкие разрывы в линиях рамки (типично у lichess —
    # тонкая рамка с разрывами на ranks/files подписях).
    kernel = np.ones((3, 3), np.uint8)
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=1)

    # 4. Контуры → approxPolyDP → фильтр 4-poly.
    contours, _ = cv2.findContours(
        closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    candidates: List[Tuple[np.ndarray, float, float]] = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < MIN_AREA_FRACTION * total_area:
            continue
        if area > MAX_AREA_FRACTION * total_area:
            continue
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, APPROX_POLY_EPS_FRACTION * peri, True)
        if len(approx) != 4:
            continue
        if not cv2.isContourConvex(approx):
            continue
        quad = approx.reshape(4, 2).astype(np.float32)
        aspect = _quad_aspect_ratio(quad)
        if abs(aspect - 1.0) > MAX_ASPECT_DEVIATION:
            continue
        # Confidence — компромисс между «достаточно крупная» и
        # «достаточно квадратная». Подобрано эмпирически.
        area_score = min(1.0, area / (0.5 * total_area))
        aspect_score = 1.0 - abs(aspect - 1.0) / MAX_ASPECT_DEVIATION
        confidence = 0.5 * area_score + 0.5 * aspect_score
        candidates.append((quad, area, confidence))

    if not candidates:
        # Fallback A: Hough lines + пересечения. Полезно для досок
        # без чёткой внешней рамки, но с видимыми ranks/files.
        hough_corners = _detect_via_hough(closed, total_area)
        if hough_corners is not None:
            return _order_corners(hough_corners), 0.5

        # Fallback B: «весь кадр = доска». Типично для PNG-render'ов
        # API (lichess `fen.gif`, chess.com diagram-generator,
        # `react-chessboard` screenshot) — изображение содержит ТОЛЬКО
        # доску без рамок и полей. Активируется только если
        # `image_aspect ≈ 1.0` (квадратное изображение) и есть
        # достаточно edge-сигнала для подтверждения «не пустой кадр»
        # (защита от ложно-positive на однотонных картинках).
        full_frame = _detect_via_full_frame(image, edges, total_area)
        if full_frame is not None:
            return _order_corners(full_frame), 0.6

        return None, 0.0

    # Выбираем кандидата с максимальной confidence; при равенстве —
    # с большей площадью (главная доска обычно крупнее).
    candidates.sort(key=lambda c: (c[2], c[1]), reverse=True)
    best_quad, _, best_confidence = candidates[0]
    return _order_corners(best_quad), best_confidence


def _detect_via_full_frame(
    image: np.ndarray,
    edges: np.ndarray,
    total_area: float,
) -> Optional[np.ndarray]:
    """Fallback B: «весь кадр — доска».

    Активируется когда других кандидатов нет — типично для прямых
    PNG/GIF render'ов API (lichess `fen.gif`, chess.com diagram).
    Условия:
      1. image_aspect ∈ [0.85, 1.18] (близко к квадрату; ratio bbox
         доски ≈ 1.0 ± 15% после anti-alias).
      2. edges mean ≥ 5 — есть структурный сигнал на изображении
         (защита от ложного срабатывания на однотонной картинке).
      3. Доминирующая структура 8×8 — проверим через автокорреляцию
         (KS-2362 закроет эту проверку строже; здесь — мягкая).
    """
    h, w = image.shape[:2]
    aspect = max(h, w) / min(h, w)
    if aspect > 1.18:
        return None
    # Edge mean >= 2.0 — есть хоть какая-то структура (отсекаем
    # однотонные и почти-пустые картинки). Стилизованные piece-set'ы
    # (например Lichess `pirouetti`) дают mean ≈ 3 — порог 2.0
    # достаточен.
    if float(edges.mean()) < 2.0:
        return None
    corners = np.array(
        [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]],
        dtype=np.float32,
    )
    return corners


def _detect_via_hough(
    edges: np.ndarray,
    total_area: float,
) -> Optional[np.ndarray]:
    """Fallback: ищем 4 пересечения горизонтальных/вертикальных линий
    через probabilistic Hough. Используется когда `findContours` не
    выделил чёткий 4-угольник (часто на досках без рамки на одноцветном
    фоне).
    """
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=80,
        minLineLength=int(0.3 * np.sqrt(total_area)),
        maxLineGap=20,
    )
    if lines is None or len(lines) < 4:
        return None

    horizontals: List[Tuple[int, int, int, int]] = []
    verticals: List[Tuple[int, int, int, int]] = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        dx = abs(x2 - x1)
        dy = abs(y2 - y1)
        if dx > 3 * dy:
            horizontals.append((x1, y1, x2, y2))
        elif dy > 3 * dx:
            verticals.append((x1, y1, x2, y2))

    if len(horizontals) < 2 or len(verticals) < 2:
        return None

    # Берём крайние линии в каждом направлении.
    horizontals.sort(key=lambda l: (l[1] + l[3]) / 2)
    verticals.sort(key=lambda l: (l[0] + l[2]) / 2)
    top = horizontals[0]
    bottom = horizontals[-1]
    left = verticals[0]
    right = verticals[-1]

    tl = _intersect(top, left)
    tr = _intersect(top, right)
    bl = _intersect(bottom, left)
    br = _intersect(bottom, right)
    if any(p is None for p in (tl, tr, bl, br)):
        return None

    corners = np.array([tl, tr, br, bl], dtype=np.float32)
    aspect = _quad_aspect_ratio(corners)
    if abs(aspect - 1.0) > MAX_ASPECT_DEVIATION:
        return None
    return corners


def _intersect(
    a: Tuple[int, int, int, int],
    b: Tuple[int, int, int, int],
) -> Optional[Tuple[float, float]]:
    """Пересечение двух отрезков, продолженных до прямых.
    Возвращает (x, y) либо None если линии параллельны.
    """
    x1, y1, x2, y2 = a
    x3, y3, x4, y4 = b
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-6:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    x = x1 + t * (x2 - x1)
    y = y1 + t * (y2 - y1)
    return (x, y)


# ─── UNet fallback (KS-2361) ────────────────────────────────────────


def _detect_with_unet_safe(
    image: np.ndarray,
    model_path: Optional[str],
) -> Tuple[Optional[np.ndarray], float]:
    """Wrapper над `detect_with_unet`, который ловит ошибки и не
    роняет вызывающий код. Если модель не указана/не найдена —
    `(None, 0.0)` без логов (graceful skip — это нормальный путь).
    """
    if not model_path or not os.path.exists(model_path):
        return None, 0.0
    try:
        return detect_with_unet(image, model_path)
    except Exception as exc:  # noqa: BLE001 — fallback must never throw
        # Логируем в stderr, но не падаем — pipeline продолжит с
        # OpenCV-результатом или вернёт failed.
        print(
            f'[board_detect] UNet inference failed: {exc}',
            file=sys.stderr,
        )
        return None, 0.0


def detect_with_unet(
    image: np.ndarray,
    model_path: str,
) -> Tuple[Optional[np.ndarray], float]:
    """Hook для UNet fallback.

    TODO (KS-2361): активируется после обучения сегментационной модели
    на датасете из KS-2360. Сейчас здесь только интерфейс:
      - input: BGR image (H, W, 3), произвольный размер.
      - resize до 256×256.
      - inference через onnxruntime → mask (256, 256).
      - findContours по маске → minAreaRect / approxPolyDP → 4 corners.
      - rescale обратно в координаты исходного изображения.
      - confidence из среднего значения mask внутри найденного 4-poly.

    Args:
        image: BGR (H, W, 3).
        model_path: путь к .onnx-файлу (UNet, single-channel sigmoid output).

    Returns:
        (corners (4, 2) в порядке TL,TR,BR,BL; confidence [0..1])
        либо (None, 0.0) если модель не нашла валидной маски.

    Raises:
        FileNotFoundError если модель не существует (но вызывающий
        код в `_detect_with_unet_safe` ловит exceptions).
    """
    # KS-2361 заглушка. Когда модель появится, импорт onnxruntime
    # делается лениво, чтобы не платить за загрузку библиотеки на
    # каждый OpenCV-only вызов.
    raise NotImplementedError(
        'UNet fallback не реализован (KS-2361). '
        'Передайте обученную ONNX-модель через --unet-model после '
        'завершения KS-2361.'
    )


# ─── Геометрия ────────────────────────────────────────────────────


def _order_corners(corners: np.ndarray) -> np.ndarray:
    """Сортирует 4 точки в порядке TL, TR, BR, BL.

    Алгоритм: суммы x+y минимальны для TL, максимальны для BR;
    разности y-x для других. Работает для любых углов, включая
    повёрнутые доски.
    """
    pts = corners.reshape(4, 2).astype(np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).flatten()
    ordered = np.zeros((4, 2), dtype=np.float32)
    ordered[0] = pts[np.argmin(s)]       # TL (min x+y)
    ordered[2] = pts[np.argmax(s)]       # BR (max x+y)
    ordered[1] = pts[np.argmin(d)]       # TR (min y-x)
    ordered[3] = pts[np.argmax(d)]       # BL (max y-x)
    return ordered


def _quad_aspect_ratio(quad: np.ndarray) -> float:
    """Aspect ratio (max(width, height) / min(...)) bounding-box'а 4-угольника."""
    xs = quad[:, 0]
    ys = quad[:, 1]
    width = float(xs.max() - xs.min())
    height = float(ys.max() - ys.min())
    if min(width, height) < 1.0:
        return 999.0
    return max(width, height) / min(width, height)


def _warp_to_square(
    image: np.ndarray,
    corners: np.ndarray,
    size: int,
) -> np.ndarray:
    """Perspective warp 4-угольника в квадрат size×size."""
    dst = np.array(
        [[0, 0], [size - 1, 0], [size - 1, size - 1], [0, size - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(corners.astype(np.float32), dst)
    return cv2.warpPerspective(image, matrix, (size, size))


# ─── CLI ──────────────────────────────────────────────────────────


def _cli() -> int:
    parser = argparse.ArgumentParser(
        description='KS-2359 / ADR-040 Stage 1: board detection.',
    )
    parser.add_argument('image', help='Path to input image (PNG/JPG).')
    parser.add_argument(
        '--out',
        help='Path to save warped 512×512 board (PNG). Default: skip.',
    )
    parser.add_argument(
        '--unet-model',
        help='Path to ONNX UNet model for fallback (KS-2361).',
    )
    parser.add_argument(
        '--json',
        action='store_true',
        help='Output JSON to stdout instead of human-readable.',
    )
    args = parser.parse_args()

    result = detect_board(args.image, unet_model_path=args.unet_model)

    # warped — ndarray, не JSON-serializable. Снимаем перед dump'ом.
    warped = result.pop('warped', None)

    if args.out and result['success'] and warped is not None:
        ok = cv2.imwrite(args.out, warped)
        if not ok:
            print(
                f'[board_detect] cannot write output: {args.out}',
                file=sys.stderr,
            )
            return 2

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        if result['success']:
            corners_str = ', '.join(f'({c[0]},{c[1]})' for c in result['corners'])
            print(
                f"success=true method={result['method']} "
                f"confidence={result['confidence']:.3f} "
                f"corners=[{corners_str}]"
            )
        else:
            err = result.get('error', '')
            print(
                f"success=false method=failed"
                + (f" error={err}" if err else ''),
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(_cli())
