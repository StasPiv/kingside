#!/usr/bin/env bash
# KS-3091 (ADR-040-v2 §6 этап B). Публикация board-recog датасета в S3
# `kingside-ml/datasets/board-recog/<dataset_ver>/`.
#
# Использование:
#   tools/upload-board-dataset.sh [path/to/data/v2] [dataset_ver]
#
# Если путь не передан — берётся стандартное расположение
# packages/board-image-to-fen/data/v2.
# Если dataset_ver не передан — публикуем под префиксом `v2` (обратная
# совместимость). Для итераций v2 с теми же manifest_v2.json
# (например ребиланс train с augmentation) — передавай v2.1, v2.2 и т.д.
#
# Файлы, которые льются (если присутствуют):
#   cells_train.h5      — packed train cells (PNG bytes + labels + styles)
#   cells_val.h5        — packed val cells   (PNG + labels + styles + fen_idx)
#   manifest_v2.json    — стили (usage, license, sha256), счётчики, лицензии
#   val_fens.json       — 500 FEN'ов + их sha256 (для воспроизводимости)
#   preview/train_grid.png + preview/val_grid.png — визуальные превью-сетки
#
# AWS-доступ через стандартные переменные окружения / профайл (regional
# default eu-central-1). Скрипт идемпотентный (`aws s3 sync` под капотом)
# но манифест и preview всегда пере-льются (`aws s3 cp`).

set -euo pipefail

BUCKET="kingside-ml"
REGION="eu-central-1"

DATA_DIR="${1:-packages/board-image-to-fen/data/v2}"
DATASET_VER="${2:-v2}"

if [[ ! "$DATASET_VER" =~ ^v[0-9]+(\.[0-9]+)?$ ]]; then
  echo "error: dataset_ver должен матчить ^v[0-9]+(\.[0-9]+)?$ (например v2, v2.1), got: $DATASET_VER" >&2
  exit 2
fi

PREFIX="datasets/board-recog/${DATASET_VER}"

if [[ ! -d "$DATA_DIR" ]]; then
  echo "error: $DATA_DIR не существует. Запусти dataset_gen.py сначала." >&2
  exit 2
fi

if [[ ! -f "$DATA_DIR/manifest_v2.json" ]]; then
  echo "error: $DATA_DIR/manifest_v2.json отсутствует (нечего публиковать)." >&2
  exit 2
fi

# Минимальная валидация манифеста — JSON корректен, инвариант изоляции ok.
python3 - "$DATA_DIR/manifest_v2.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
inv = m.get("isolation_invariant", {})
assert inv.get("valid") is True, f"isolation_invariant.valid != true: {inv}"
assert m.get("version") == "v2", f"manifest.version != v2: {m.get('version')}"
print("[upload] manifest sanity ok: isolation invariant valid, version v2")
PY

S3_BASE="s3://${BUCKET}/${PREFIX}"

echo "[upload] target: ${S3_BASE}"
echo "[upload] source: ${DATA_DIR}"

# HDF5 артефакты — основной груз. Если файла нет — пропускаем (например,
# при --style-set train не будет cells_val.h5).
for f in cells_train.h5 cells_val.h5; do
  src="$DATA_DIR/$f"
  if [[ -f "$src" ]]; then
    size_h=$(du -h "$src" | cut -f1)
    echo "[upload] $f ($size_h) → ${S3_BASE}/$f"
    aws s3 cp --region "$REGION" "$src" "${S3_BASE}/$f"
  else
    echo "[skip]   $f отсутствует в $DATA_DIR"
  fi
done

# Manifest + val_fens.json — всегда.
for f in manifest_v2.json val_fens.json; do
  src="$DATA_DIR/$f"
  if [[ -f "$src" ]]; then
    echo "[upload] $f → ${S3_BASE}/$f"
    aws s3 cp --region "$REGION" "$src" "${S3_BASE}/$f"
  fi
done

# Preview-сетки — отдельная директория.
if [[ -d "$DATA_DIR/preview" ]]; then
  echo "[upload] preview/ → ${S3_BASE}/preview/"
  aws s3 sync --region "$REGION" "$DATA_DIR/preview/" "${S3_BASE}/preview/"
fi

echo
echo "=== Upload complete ==="
echo "S3 prefix: ${S3_BASE}/"
echo
echo "Чтобы скачать обратно на CPU-инстанс для тренировки:"
echo "  aws s3 sync ${S3_BASE}/ ./data/v2/"
