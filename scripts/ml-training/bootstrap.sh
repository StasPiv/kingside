#!/bin/bash
# KS-3071 / KS-3073 runbook §3.5 — bootstrap inside pytorch Docker container.
# Запускается user-data.sh внутри `pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime`.
# Никаких apt; всё через pip внутри образа.

set -euxo pipefail
cd /work

EXPECTED_SHA="43e354e496d0c355a75a8d87578153e7eafd7b573e98ccbb2f765192bbca9842"
ACTUAL_SHA=$(sha256sum code.tar.gz | awk '{print $1}')
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "code.tar.gz sha mismatch: got $ACTUAL_SHA, want $EXPECTED_SHA" >&2
  exit 1
fi

# Архив пакован backend'ом так, что верхний каталог — `training/`
# (см. KS-3071, agent_message backend 2026-05-17, sha=$EXPECTED_SHA).
tar xzf code.tar.gz
test -f training/train.py
test -f training/requirements.txt

# torch / torchvision уже в образе — не переустанавливаем (см. runbook §3.8).
# awscli нужен для S3 sync / cp. opencv-python-headless и прочее ставится из requirements.
grep -v '^torch' training/requirements.txt | grep -v '^torchvision' > /tmp/req-noco-torch.txt
pip install --no-cache-dir -r /tmp/req-noco-torch.txt awscli

# Sanity GPU. Если контейнер запущен без --gpus all (dry-run) — это всё ещё ok,
# train.py возьмёт --device cpu из аргументов.
python -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), 'devices', torch.cuda.device_count())"

# Датасет v1 -> /work/data. Через instance-profile, ключи не нужны.
mkdir -p /work/data
aws s3 sync s3://kingside-ml/datasets/board-recog/v1/ /work/data/ \
    --exclude '*' \
    --include 'cells/*' \
    --include 'splits/*' \
    --include 'manifest_v1.json'
du -sh /work/data

# Тренировка. width-mult=0.5 — целевой бюджет ONNX ≤ 1 MB (README KS-2361).
RUN_ID="${RUN_ID:?RUN_ID must be set by user-data}"
mkdir -p "/work/runs/$RUN_ID"

python -m training.train \
    --data-dir /work/data \
    --output   "/work/runs/$RUN_ID" \
    --epochs 20 \
    --batch-size 256 \
    --lr 1e-3 \
    --width-mult 0.5 \
    --num-workers 4 \
    --early-stop-patience 3 \
    --export-onnx

ls -la "/work/runs/$RUN_ID/"
ls -la "/work/runs/$RUN_ID/model.onnx"

# Оценка PyTorch-чекпойнта.
python -m training.evaluate \
    --data-dir /work/data \
    --checkpoint "/work/runs/$RUN_ID/best.pt" \
    --split val

# Оценка экспортированного ONNX — убедиться что export не уронил точность.
python -m training.evaluate \
    --data-dir /work/data \
    --checkpoint "/work/runs/$RUN_ID/model.onnx" \
    --split val \
    --output "/work/runs/$RUN_ID/evaluation_report.onnx.json" || \
  echo "WARN: ONNX evaluate не отработал; смотрим evaluation_report.json"

# Заливка артефактов в _tmp/runs/ (не в models/ — это делает человек после ревью).
aws s3 cp "/work/runs/$RUN_ID/" "s3://kingside-ml/_tmp/runs/$RUN_ID/" \
    --recursive \
    --exclude '*' \
    --include 'model.onnx' \
    --include 'best.pt' \
    --include 'last.pt' \
    --include 'evaluation_report.json' \
    --include 'evaluation_report.onnx.json' \
    --include 'train_log.jsonl' \
    --include 'training_meta.json'

echo "[done] artifacts: s3://kingside-ml/_tmp/runs/$RUN_ID/"
