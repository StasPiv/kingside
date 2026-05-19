#!/bin/bash
# scripts/ml-training/yolo-gpu/user-data-baked.sh
#
# Запускается на инстансе, поднятом из baked AMI (kingside-gpu-pilot-baked-*).
# В отличие от user-data-cold.sh не делает pip install — torch + ultralytics
# + deps уже запечены в AMI. Только смонтировать NVMe, подтянуть датасет,
# поставить READY-маркер.
#
# Размер скрипта мал → setup-время с ~4 мин (cold) сокращается до ~30–60 сек.
#
# В шаблон launch.sh подставит:
#   __DATASET_TAR__  — например "v4-objdet.tar"

set -uxo pipefail
exec > >(tee -a /var/log/kingside-setup.log) 2>&1
echo "=== kingside-gpu-pilot baked setup start: $(date -Iseconds) ==="

NVME=/opt/dlami/nvme
DATASET_TAR="__DATASET_TAR__"

# NVMe готовность — AMI монтирует автоматически, нам только проверить и chown.
test -d "$NVME"
chown -R ubuntu:ubuntu "$NVME"
sudo -u ubuntu mkdir -p "$NVME/data" "$NVME/runs"
df -h "$NVME"

# Sanity: torch + ultralytics уже в образе.
sudo -u ubuntu /opt/conda/bin/python - <<'PY'
import torch, ultralytics
print('torch', torch.__version__, 'cuda', torch.cuda.is_available(),
      'device', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no-cuda')
print('ultralytics', ultralytics.__version__)
PY

# Pull dataset
sudo -u ubuntu aws s3 cp \
    "s3://kingside-ml/datasets/board-recog/${DATASET_TAR}" \
    "${NVME}/${DATASET_TAR}" \
    --region eu-central-1

# Untar
sudo -u ubuntu tar -xf "${NVME}/${DATASET_TAR}" -C "${NVME}/data"
DATASET_DIR="${NVME}/data/${DATASET_TAR%.tar}"
ls -la "$DATASET_DIR" || true

# Patch dataset.yaml на абсолютный path
if [ -f "${DATASET_DIR}/dataset.yaml" ]; then
    sudo -u ubuntu python3 - <<PY
import re, pathlib
p = pathlib.Path("${DATASET_DIR}/dataset.yaml")
txt = p.read_text()
txt = re.sub(r'^path:.*$', 'path: ${DATASET_DIR}', txt, flags=re.M)
p.write_text(txt)
print(txt)
PY
fi

# yolov8n.pt в baked AMI не запечён (он лежал на NVMe instance store).
# Префетчим заново — это ~6 МБ, ~1 сек.
sudo -u ubuntu /opt/conda/bin/python -c \
    "from ultralytics import YOLO; YOLO('yolov8n.pt')" || true

# READY-маркер
echo "READY $(date -Iseconds)" | sudo -u ubuntu tee "${NVME}/READY"
echo "=== kingside-gpu-pilot baked setup done: $(date -Iseconds) ==="
