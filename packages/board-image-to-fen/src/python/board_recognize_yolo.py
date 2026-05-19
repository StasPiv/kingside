#!/usr/bin/env python3
"""KS-3091 v4 / ADR-040 Stage 3 (YOLO replacement). Universal board recognition
через object detection вместо per-cell classification.

Pipeline:

    image (PNG/JPG)
        ↓
    [Stage 1: board_detect]            ← KS-2359 (board_detect.py)
        ↓
    warped 512×512 BGR
        ↓
    [Stage 2: YOLOv8n детектор фигур]  ← KS-3091 v4 (yolov8n ONNX)
        ↓
    список bbox + class + confidence
        ↓
    [Stage 3: bbox → 8×8 grid + orientation + FEN + sanity]

Принципиальное отличие от ``board_recognize.py`` (v1, per-cell):
  • Один прогон ONNX на всю доску, не 64 прогона на 64 клетки.
  • Фон клетки не влияет на распознавание — модель опирается на силуэт фигуры.
  • Inference в 30-50× быстрее на CPU (50ms vs 3000ms).

Контракт ответа совместим с board_recognize.recognize() — те же поля
fen, fen_board, orientation, cells, low_confidence_cells, sanity. Service
``board-recognition.service.ts`` его без изменений переваривает.

## CLI

    python3 board_recognize_yolo.py <image> --model <yolo.onnx>
                                   [--orientation auto|white|black]
                                   [--low-confidence-threshold 0.65]
                                   [--detect-conf 0.25]
                                   [--json]

## Python API

    from board_recognize_yolo import recognize
    result = recognize('screenshot.png', model_path='yolov8n.onnx')
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from board_detect import detect_board as _heuristic_detect_board
from board_recognize import (
    LABEL_TO_FEN,
    _algebraic,
    _bbox_from_corners,
    _flip_grid,
    _grid_to_fen,
    _infer_orientation,
    _sanity_check,
    _nn_detect_board,
    detect_board,
)


# ─── Constants ───────────────────────────────────────────────────────

# YOLO порядок классов (см. board_dataset_gen.py CLASS_NAMES).
# 0..5 — белые: K, Q, R, B, N, P. 6..11 — чёрные: K, Q, R, B, N, P.
YOLO_CLASS_NAMES: List[str] = [
    "wK", "wQ", "wR", "wB", "wN", "wP",
    "bK", "bQ", "bR", "bB", "bN", "bP",
]

# Размер квадрата после warp — должен совпадать с imgsz при тренировке YOLO.
WARP_SIZE = 512
CELL_SIZE = WARP_SIZE // 8   # 64
GRID_SIZE = 8

# Конфиденс — порог детекции YOLO. На синтетическом val ≥0.99 у настоящих
# фигур; 0.25 — стандартный YOLO threshold, отсеивает большинство шума.
DEFAULT_DETECT_CONF = 0.25
DEFAULT_IOU_NMS = 0.45

# Low-confidence для возврата в UI как «уточни». На YOLO распределение
# другое — фигуры обычно >0.85, что ниже — сомнительно.
DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.65

DEFAULT_MODEL_ENV = "BOARD_RECOG_MODEL_PATH"


# ─── Public API ──────────────────────────────────────────────────────


def recognize(
    image_path: str,
    model_path: Optional[str] = None,
    orientation: str = "auto",
    low_confidence_threshold: float = DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    detect_conf: float = DEFAULT_DETECT_CONF,
    iou_nms: float = DEFAULT_IOU_NMS,
    unet_model_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Полный pipeline на YOLO. Возвращает dict в формате board_recognize.recognize()."""
    if orientation not in ("auto", "white", "black"):
        raise ValueError(f"orientation must be auto|white|black, got {orientation!r}")

    resolved_model = _resolve_model_path(model_path)

    # Stage 1: board detection + warp в 512×512.
    detect = detect_board(image_path, unet_model_path=unet_model_path)
    if not detect.get("success"):
        return {
            "success": False,
            "stage": "detect",
            "error": detect.get("error") or "board detection failed",
            "detect": {
                "method": detect.get("method"),
                "confidence": detect.get("confidence", 0.0),
                "corners": detect.get("corners"),
                "image_size": detect.get("image_size"),
            },
        }

    warped = detect.pop("warped", None)
    if warped is None:
        return {
            "success": False,
            "stage": "detect",
            "error": "warped image missing",
            "detect": detect,
        }

    # Stage 2+3: YOLO inference + grid + FEN + sanity.
    result = _recognize_from_warped(
        warped, resolved_model,
        orientation=orientation,
        low_confidence_threshold=low_confidence_threshold,
        detect_conf=detect_conf,
        iou_nms=iou_nms,
    )

    image_size = detect.get("image_size") or [warped.shape[1], warped.shape[0]]
    corners = detect.get("corners") or []
    bbox = _bbox_from_corners(corners) if corners else [
        0, 0, int(image_size[0]), int(image_size[1])
    ]
    result["bbox"] = bbox
    result["detect"] = {
        "method": detect.get("method"),
        "confidence": float(detect.get("confidence", 0.0)),
        "corners": corners,
        "image_size": image_size,
    }
    return result


def _recognize_from_warped(
    warped: "np.ndarray",
    model_path: str,
    orientation: str = "auto",
    low_confidence_threshold: float = DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    detect_conf: float = DEFAULT_DETECT_CONF,
    iou_nms: float = DEFAULT_IOU_NMS,
) -> Dict[str, Any]:
    """Core YOLO inference на готовом warped (512×512) изображении.

    Не делает board-detect (Stage 1) — принимает уже выпрямленную доску.
    Используется и в `recognize()` (после corner-detector warp), и в
    `recognize_multi()` (после find-boards crop).
    """
    detections = _run_yolo(model_path, warped, detect_conf, iou_nms)
    raw_grid, raw_conf, raw_top3 = _detections_to_grid(detections)

    effective_orientation = (
        _infer_orientation(raw_grid) if orientation == "auto" else orientation
    )
    if effective_orientation == "black":
        oriented_grid = _flip_grid(raw_grid)
        oriented_conf = _flip_grid(raw_conf)
        oriented_top3 = _flip_grid(raw_top3)
    else:
        oriented_grid = raw_grid
        oriented_conf = raw_conf
        oriented_top3 = raw_top3

    fen_board = _grid_to_fen(oriented_grid)
    fen = f"{fen_board} w - - 0 1"
    sanity = _sanity_check(oriented_grid)

    cells_payload: List[Dict[str, Any]] = []
    low_conf_payload: List[Dict[str, Any]] = []
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            label = oriented_grid[r][c]
            cell = {
                "row": r,
                "col": c,
                "square": _algebraic(r, c, effective_orientation),
                "bg": "l" if (r + c) % 2 == 0 else "d",
                "predicted": label,
                "piece": LABEL_TO_FEN[label] or ".",
                "confidence": float(oriented_conf[r][c]),
                "top3": [
                    {"label": lbl, "prob": float(prob)}
                    for lbl, prob in oriented_top3[r][c]
                ],
            }
            cells_payload.append(cell)
            if label != "empty" and oriented_conf[r][c] < low_confidence_threshold:
                low_conf_payload.append(cell)

    return {
        "success": True,
        "stage": None,
        "fen": fen,
        "fen_board": fen_board,
        "orientation": effective_orientation,
        "cells": cells_payload,
        "low_confidence_cells": low_conf_payload,
        "sanity": sanity,
        "model_path": model_path,
        "model_kind": "yolo_v8n_objdet_v2",
    }


# ─── Internals ───────────────────────────────────────────────────────


def _resolve_model_path(model_path: Optional[str]) -> str:
    path = model_path or os.environ.get(DEFAULT_MODEL_ENV)
    if not path:
        raise FileNotFoundError(
            "ONNX model not provided. Pass --model <path> or set "
            f"${DEFAULT_MODEL_ENV}."
        )
    if not os.path.isfile(path):
        raise FileNotFoundError(f"ONNX model not found: {path}")
    return path


def _run_yolo(
    model_path: str,
    warped_bgr: np.ndarray,
    conf_threshold: float,
    iou_threshold: float,
) -> List[Dict[str, Any]]:
    """YOLO ONNX inference + NMS.

    Возвращает список детекций {cx, cy, w, h, class_idx, confidence} в
    пикселях warped-канваса (0..WARP_SIZE).
    """
    import onnxruntime as ort

    # Препроцесс: BGR → RGB, [0..1], (3,H,W), float32.
    if warped_bgr.shape[:2] != (WARP_SIZE, WARP_SIZE):
        raise ValueError(
            f"warped image must be {WARP_SIZE}×{WARP_SIZE}, got {warped_bgr.shape}"
        )
    rgb = warped_bgr[..., ::-1].astype(np.float32) / 255.0
    chw = np.transpose(rgb, (2, 0, 1))[None]  # (1, 3, H, W)

    providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider")
                 if p in ort.get_available_providers()]
    sess = ort.InferenceSession(model_path, providers=providers)
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name
    out = sess.run([out_name], {in_name: chw})[0]
    # YOLOv8 ONNX output shape: (1, 4+nc, num_anchors).
    # Например для nc=12, imgsz=512 → (1, 16, 5376).
    out = out[0]                      # (4+nc, num_anchors)
    nc = len(YOLO_CLASS_NAMES)
    boxes = out[:4, :].T              # (num_anchors, 4) — cx, cy, w, h
    class_scores = out[4:4 + nc, :].T # (num_anchors, nc)

    # Конфиденс = max class score (для каждого якоря).
    class_idx = class_scores.argmax(axis=1)
    conf = class_scores[np.arange(class_scores.shape[0]), class_idx]
    mask = conf >= conf_threshold
    boxes = boxes[mask]
    class_idx = class_idx[mask]
    conf = conf[mask]

    if boxes.shape[0] == 0:
        return []

    # NMS — отдельно по каждому классу.
    keep = _nms_per_class(boxes, class_idx, conf, iou_threshold)
    detections: List[Dict[str, Any]] = []
    for i in keep:
        cx, cy, w, h = boxes[i]
        detections.append({
            "cx": float(cx),
            "cy": float(cy),
            "w": float(w),
            "h": float(h),
            "class_idx": int(class_idx[i]),
            "confidence": float(conf[i]),
        })
    return detections


def _nms_per_class(
    boxes: np.ndarray, class_idx: np.ndarray, conf: np.ndarray,
    iou_threshold: float,
) -> List[int]:
    """Возвращает индексы детекций, переживших NMS (по каждому классу отдельно)."""
    keep: List[int] = []
    for cls in np.unique(class_idx):
        cls_mask = (class_idx == cls)
        cls_indices = np.where(cls_mask)[0]
        cls_boxes = boxes[cls_indices]   # (N, 4) cx,cy,w,h
        cls_conf = conf[cls_indices]     # (N,)
        # Преобразуем в xyxy для IoU.
        x1 = cls_boxes[:, 0] - cls_boxes[:, 2] / 2
        y1 = cls_boxes[:, 1] - cls_boxes[:, 3] / 2
        x2 = cls_boxes[:, 0] + cls_boxes[:, 2] / 2
        y2 = cls_boxes[:, 1] + cls_boxes[:, 3] / 2
        areas = (x2 - x1) * (y2 - y1)
        order = cls_conf.argsort()[::-1]
        suppressed = np.zeros(len(order), dtype=bool)
        for i_pos, i in enumerate(order):
            if suppressed[i_pos]:
                continue
            keep.append(int(cls_indices[i]))
            xx1 = np.maximum(x1[i], x1[order[i_pos + 1:]])
            yy1 = np.maximum(y1[i], y1[order[i_pos + 1:]])
            xx2 = np.minimum(x2[i], x2[order[i_pos + 1:]])
            yy2 = np.minimum(y2[i], y2[order[i_pos + 1:]])
            w_int = np.maximum(0.0, xx2 - xx1)
            h_int = np.maximum(0.0, yy2 - yy1)
            inter = w_int * h_int
            union = areas[i] + areas[order[i_pos + 1:]] - inter
            iou = np.where(union > 0, inter / union, 0.0)
            suppressed[i_pos + 1:] |= (iou > iou_threshold)
    return keep


def _detections_to_grid(
    detections: List[Dict[str, Any]],
) -> Tuple[List[List[str]], List[List[float]], List[List[List[Tuple[str, float]]]]]:
    """Список bbox → grid 8×8 (label, confidence, top3).

    Каждая детекция мапится на клетку по координате центра. Если в одну
    клетку попало несколько — выбираем максимальную confidence.
    Пустые клетки получают label="empty", confidence=1.0.
    """
    grid_label: List[List[str]] = [["empty"] * GRID_SIZE for _ in range(GRID_SIZE)]
    grid_conf: List[List[float]] = [[1.0] * GRID_SIZE for _ in range(GRID_SIZE)]
    grid_top3: List[List[List[Tuple[str, float]]]] = [
        [[("empty", 1.0)] for _ in range(GRID_SIZE)]
        for _ in range(GRID_SIZE)
    ]

    # Для каждой детекции: попадает ли центр в одну из 64 клеток?
    for d in detections:
        col = int(d["cx"] // CELL_SIZE)
        row = int(d["cy"] // CELL_SIZE)
        if not (0 <= row < GRID_SIZE and 0 <= col < GRID_SIZE):
            continue
        cls = YOLO_CLASS_NAMES[d["class_idx"]]
        conf = d["confidence"]
        # Если в эту клетку уже была фигура — берём с большей confidence.
        if grid_label[row][col] != "empty" and conf <= grid_conf[row][col]:
            # Существующий вариант — лучший. Добавим текущий в top3.
            grid_top3[row][col].append((cls, conf))
            continue
        # Иначе — новый top-1, прежний (если был) уходит в top3.
        old = grid_label[row][col], grid_conf[row][col]
        grid_label[row][col] = cls
        grid_conf[row][col] = conf
        new_top3 = [(cls, conf)]
        if old[0] != "empty":
            new_top3.append(old)
        grid_top3[row][col] = new_top3

    # Усечь top3 до 3 элементов.
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            grid_top3[r][c] = sorted(grid_top3[r][c], key=lambda x: -x[1])[:3]
    return grid_label, grid_conf, grid_top3


# ─── Stage 0: find-boards (KS-3110) ──────────────────────────────────


def find_boards(
    image_path: str,
    find_boards_model_path: str,
    conf_threshold: float = 0.25,
    iou_threshold: float = 0.45,
    imgsz: int = 512,
) -> List[Dict[str, Any]]:
    """KS-3110: найти все доски на исходном скриншоте.

    Возвращает список ``[{'bbox':[x0,y0,x1,y1], 'confidence': float}, ...]``
    в координатах исходной картинки. Bbox — квадрат с захватом всей
    доски (включая обвязку, если она маленькая).

    Использует отдельную YOLOv8n ONNX модель (nc=1, class='board'),
    обученную в KS-3110. На синтетическом val mAP50=0.995, на реальных
    скриншотах 13/14 sanity OK.
    """
    import cv2
    import onnxruntime as ort

    bgr = cv2.imread(image_path)
    if bgr is None:
        raise FileNotFoundError(f"cv2.imread failed: {image_path}")
    orig_h, orig_w = bgr.shape[:2]

    # YOLO letterbox: ресайз до imgsz сохраняя aspect-ratio + паддинг.
    scale = imgsz / max(orig_w, orig_h)
    new_w, new_h = int(round(orig_w * scale)), int(round(orig_h * scale))
    resized = cv2.resize(bgr, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    pad_w = imgsz - new_w
    pad_h = imgsz - new_h
    top = pad_h // 2
    left = pad_w // 2
    canvas = np.full((imgsz, imgsz, 3), 114, dtype=np.uint8)
    canvas[top:top + new_h, left:left + new_w] = resized

    rgb = canvas[..., ::-1].astype(np.float32) / 255.0
    chw = np.transpose(rgb, (2, 0, 1))[None]  # (1,3,imgsz,imgsz)

    providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider")
                 if p in ort.get_available_providers()]
    sess = ort.InferenceSession(find_boards_model_path, providers=providers)
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name
    out = sess.run([out_name], {in_name: chw})[0]
    # YOLOv8 1-class: shape (1, 5, num_anchors) — 4 bbox + 1 class score.
    out = out[0]                       # (5, num_anchors)
    boxes = out[:4, :].T               # (num_anchors, 4) — cx,cy,w,h
    conf = out[4, :]                   # (num_anchors,)

    mask = conf >= conf_threshold
    boxes = boxes[mask]
    conf = conf[mask]
    if boxes.shape[0] == 0:
        return []

    # NMS — один класс.
    class_idx = np.zeros(boxes.shape[0], dtype=np.int64)
    keep = _nms_per_class(boxes, class_idx, conf, iou_threshold)

    # Преобразование координат: letterbox imgsz → original image.
    results: List[Dict[str, Any]] = []
    for i in keep:
        cx, cy, w, h = boxes[i]
        # Снимаем letterbox-сдвиг.
        cx -= left
        cy -= top
        # Снимаем letterbox-скейл.
        cx /= scale; cy /= scale
        w /= scale;  h /= scale
        x0 = max(0.0, cx - w / 2)
        y0 = max(0.0, cy - h / 2)
        x1 = min(float(orig_w), cx + w / 2)
        y1 = min(float(orig_h), cy + h / 2)
        if x1 <= x0 or y1 <= y0:
            continue
        # Filter: только квадратные bbox-ы (aspect-ratio ≈ 1:1 ± 25%).
        bw = x1 - x0
        bh = y1 - y0
        ar = bw / max(1.0, bh)
        if ar < 0.75 or ar > 1.33:
            continue
        # Filter: минимальный размер 80×80 (мелкий шум).
        if bw < 80 or bh < 80:
            continue
        results.append({
            "bbox": [int(x0), int(y0), int(x1), int(y1)],
            "confidence": float(conf[i]),
        })
    # Сортируем по чтению: сверху вниз, слева направо.
    results.sort(key=lambda b: (b["bbox"][1] // 100, b["bbox"][0]))
    return results


def recognize_multi(
    image_path: str,
    find_boards_model_path: Optional[str] = None,
    find_pieces_model_path: Optional[str] = None,
    orientation: str = "auto",
    low_confidence_threshold: float = DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    detect_conf: float = DEFAULT_DETECT_CONF,
    iou_nms: float = DEFAULT_IOU_NMS,
    find_boards_conf: float = 0.25,
    unet_model_path: Optional[str] = None,
) -> Dict[str, Any]:
    """KS-3110 двухэтапный pipeline: найти все доски на скриншоте,
    затем для каждой прогнать find-pieces.

    Возвращает dict:
        {
          "success": True,
          "boards": [{...}, {...}, ...],   # массив результатов recognize() на каждую доску
          "n_boards_found": int,
        }

    Каждый элемент `boards` совпадает по формату с `recognize()`. Bbox в
    нём пересчитан в координаты исходной картинки.

    Если `find_boards_model_path` не задан — fallback на одну доску через
    стандартный `recognize()`.
    """
    if find_boards_model_path is None:
        find_boards_model_path = os.environ.get("BOARD_FINDBOARDS_MODEL_PATH")

    # Fallback: нет find-boards модели — единичный recognize.
    if not find_boards_model_path or not os.path.isfile(find_boards_model_path):
        single = recognize(
            image_path,
            model_path=find_pieces_model_path,
            orientation=orientation,
            low_confidence_threshold=low_confidence_threshold,
            detect_conf=detect_conf,
            iou_nms=iou_nms,
            unet_model_path=unet_model_path,
        )
        return {
            "success": single.get("success", False),
            "boards": [single] if single.get("success") else [],
            "n_boards_found": 1 if single.get("success") else 0,
            "find_boards_model": None,
        }

    # Stage 0: найти все доски.
    boards_bboxes = find_boards(image_path, find_boards_model_path, conf_threshold=find_boards_conf)
    if not boards_bboxes:
        return {
            "success": False,
            "boards": [],
            "n_boards_found": 0,
            "find_boards_model": find_boards_model_path,
            "error": "no boards detected by find-boards stage",
        }

    # Stage 1+2: для каждой доски — crop + прямой YOLO (без corner-detector).
    # Bbox от find-boards уже точный квадрат — corner-detector только
    # помешает: он часто обрезает края и теряет фигуры на краях
    # (фото деревянной доски со стрелкой — wB на e1 пропадал).
    import cv2
    resolved_pieces = _resolve_model_path(find_pieces_model_path)
    bgr_full = cv2.imread(image_path)
    boards_results: List[Dict[str, Any]] = []
    for i, bb in enumerate(boards_bboxes):
        x0, y0, x1, y1 = bb["bbox"]
        crop = bgr_full[y0:y1, x0:x1]
        if crop.size == 0:
            continue
        # Прямой resize в 512×512 (бывший warp).
        warped = cv2.resize(crop, (WARP_SIZE, WARP_SIZE), interpolation=cv2.INTER_LINEAR)
        sub = _recognize_from_warped(
            warped, resolved_pieces,
            orientation=orientation,
            low_confidence_threshold=low_confidence_threshold,
            detect_conf=detect_conf,
            iou_nms=iou_nms,
        )
        sub["bbox"] = [x0, y0, x1, y1]
        sub["board_index"] = i
        sub["find_boards_confidence"] = bb["confidence"]
        sub["detect"] = {
            "method": "find_boards_yolo",
            "confidence": float(bb["confidence"]),
            "corners": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            "image_size": [bgr_full.shape[1], bgr_full.shape[0]],
        }
        boards_results.append(sub)

    return {
        "success": any(b.get("success") for b in boards_results),
        "boards": boards_results,
        "n_boards_found": len(boards_results),
        "find_boards_model": find_boards_model_path,
    }


# ─── CLI ─────────────────────────────────────────────────────────────


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("image", help="Путь к PNG/JPG.")
    ap.add_argument("--model", help="Путь к find-pieces YOLO ONNX. Дефолт — $BOARD_RECOG_MODEL_PATH.")
    ap.add_argument("--find-boards-model", default=None,
                    help="Путь к find-boards YOLO ONNX (KS-3110). "
                         "Дефолт — $BOARD_FINDBOARDS_MODEL_PATH. Если задан — "
                         "двухэтапный pipeline (find-boards → find-pieces). "
                         "Если отсутствует — единичный recognize() через "
                         "corner-detector.")
    ap.add_argument("--multi", action="store_true",
                    help="Принудительно multi-board режим (выходной массив).")
    ap.add_argument("--orientation", default="auto",
                    choices=("auto", "white", "black"))
    ap.add_argument("--low-confidence-threshold", type=float,
                    default=DEFAULT_LOW_CONFIDENCE_THRESHOLD)
    ap.add_argument("--detect-conf", type=float, default=DEFAULT_DETECT_CONF)
    ap.add_argument("--iou-nms", type=float, default=DEFAULT_IOU_NMS)
    ap.add_argument("--unet-model", default=None,
                    help="Optional UNet для board_detect fallback.")
    ap.add_argument("--json", action="store_true",
                    help="Структурированный вывод вместо одной FEN-строки.")
    args = ap.parse_args(argv)

    fb_model = args.find_boards_model or os.environ.get("BOARD_FINDBOARDS_MODEL_PATH")
    use_multi = args.multi or bool(fb_model)

    try:
        if use_multi:
            result = recognize_multi(
                args.image,
                find_boards_model_path=fb_model,
                find_pieces_model_path=args.model,
                orientation=args.orientation,
                low_confidence_threshold=args.low_confidence_threshold,
                detect_conf=args.detect_conf,
                iou_nms=args.iou_nms,
                unet_model_path=args.unet_model,
            )
            # Back-compat: если найдена одна доска и НЕ задан --multi явно,
            # отдаём её single-payload — service не сломается.
            if not args.multi and result.get("n_boards_found", 0) == 1 and result["boards"]:
                result = result["boards"][0]
        else:
            result = recognize(
                args.image,
                model_path=args.model,
                orientation=args.orientation,
                low_confidence_threshold=args.low_confidence_threshold,
                detect_conf=args.detect_conf,
                iou_nms=args.iou_nms,
                unet_model_path=args.unet_model,
            )
    except FileNotFoundError as e:
        print(f"board_recognize_yolo: {e}", file=sys.stderr)
        if args.json:
            print(json.dumps({"success": False, "stage": "model", "error": str(e)}))
        return 2
    except Exception as e:  # noqa: BLE001
        print(f"board_recognize_yolo: unexpected error: {e}", file=sys.stderr)
        if args.json:
            print(json.dumps({"success": False, "stage": "unexpected", "error": str(e)}))
        return 1

    if args.json:
        print(json.dumps(result))
    else:
        if not result.get("success"):
            print(f"FAIL stage={result.get('stage')}: {result.get('error')}",
                  file=sys.stderr)
            return 1
        print(result["fen_board"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
