#!/bin/bash
# KS-3071 / KS-3073 runbook §4 — локальный CPU dry-run.
# Проверяет, что bootstrap (pip install + dataset sync + старт train.py)
# проходит на той же связке образ + код, что на проде. 1 эпоха, ~1000 клеток.
# Цель: не платить за GPU-минуты ради проверки опечаток bootstrap'а.
#
# Требует:
#   - docker;
#   - AWS-кредиты с GetObject на kingside-ml/_tmp/board-recog-training.tar.gz
#     и kingside-ml/datasets/board-recog/v1/ (для манифеста + mini-cells).
#   - доступа к интернету для pip install + docker pull.
#
# Время: ~10–15 мин на ноутбуке.

set -euxo pipefail

WORKDIR=${WORKDIR:-/tmp/board-recog-dryrun}
S3_CODE="s3://kingside-ml/_tmp/board-recog-training.tar.gz"
S3_DATASET="s3://kingside-ml/datasets/board-recog/v1"
IMAGE="pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime"

mkdir -p "$WORKDIR/data" "$WORKDIR/runs"

# (1) Скачиваем training-код (та же tar.gz, что попадает на инстанс).
aws s3 cp "$S3_CODE" "$WORKDIR/code.tar.gz"

# (2) Мини-датасет: манифест, splits (нужны для CellDataset), и подмножество
#     cells/ — первые 1000 объектов. Этого достаточно, чтобы dataloader не упал
#     "missing file" и одна эпоха реально что-то прогнала.
aws s3 cp "$S3_DATASET/manifest_v1.json" "$WORKDIR/data/"
aws s3 sync "$S3_DATASET/splits/" "$WORKDIR/data/splits/"

# Берём первые 1000 cells/* — не sync на всё (это ~1 М объектов).
aws s3 ls "$S3_DATASET/cells/" --recursive | head -n 1000 | awk '{print $4}' > "$WORKDIR/cells-1000.txt"
while read -r key; do
  rel=${key#datasets/board-recog/v1/}
  mkdir -p "$WORKDIR/data/$(dirname "$rel")"
  aws s3 cp "s3://kingside-ml/$key" "$WORKDIR/data/$rel" --only-show-errors
done < "$WORKDIR/cells-1000.txt"

# (3) Готовим bootstrap-like команду для контейнера. Внутри: распаковка,
#     pip install (без torch — уже в образе), train 1 эпоху на CPU.
cat > "$WORKDIR/dry-bootstrap.sh" <<'EOF'
set -euxo pipefail
cd /work
tar xzf code.tar.gz
test -f training/train.py
grep -v '^torch' training/requirements.txt | grep -v '^torchvision' > /tmp/req.txt
pip install --no-cache-dir -r /tmp/req.txt awscli
python -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"
python -m training.train \
    --data-dir /work/data \
    --output /work/runs/dryrun \
    --epochs 1 \
    --batch-size 32 \
    --num-workers 0 \
    --width-mult 0.5 \
    --device cpu
EOF
chmod +x "$WORKDIR/dry-bootstrap.sh"

# (4) Pull + run без --gpus. Тот же образ, что на проде.
docker pull "$IMAGE"
docker run --rm \
  -v "$WORKDIR:/work" \
  "$IMAGE" \
  bash /work/dry-bootstrap.sh

echo "[ok] CPU dry-run passed. Можно RunInstances на GPU."
