#!/bin/bash
# scripts/ml-training/yolo-gpu/user-data.sh
#
# Запускается ОДИН РАЗ внутри g4dn.xlarge при первом старте (как `--user-data`).
# Шаблон: launch.sh подставляет имя tar'а и записывает результат
# в /tmp/gpu-user-data.sh, кодирует base64 и передаёт в run-instances.
#
# AMI: Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.4.1 (Ubuntu 22.04).
# NVMe instance store уже смонтирован на /opt/dlami/nvme/, EBS не трогаем.
#
# В шаблон launch.sh подставит:
#   __DATASET_TAR__  — например "v4-objdet.tar" или "v5-findboards.tar"

set -uxo pipefail
exec > >(tee -a /var/log/kingside-setup.log) 2>&1
echo "=== kingside-gpu-pilot setup start: $(date -Iseconds) ==="

NVME=/opt/dlami/nvme
DATASET_TAR="__DATASET_TAR__"

# ---- 1. NVMe готовность ----------------------------------------------------
# AMI сам монтирует NVMe в /opt/dlami/nvme/, нам не нужен mkfs/mount.
# Только проверяем что директория есть и принадлежит ubuntu.
test -d "$NVME"
chown -R ubuntu:ubuntu "$NVME"
sudo -u ubuntu mkdir -p "$NVME/data" "$NVME/runs"
df -h "$NVME"

# ---- 2. Pin torch 2.4.1+cu124 ---------------------------------------------
# AMI поставляется с torch 2.4.1+cu121 — расходится с cu124, который драйвер
# поддерживает; ultralytics при загрузке тяжёлых CUDA-операций будет
# выкатывать warning, иногда падает. Пины ровно по версии backend.
sudo -u ubuntu /opt/conda/bin/pip install --quiet --upgrade --force-reinstall \
    'torch==2.4.1' 'torchvision==0.19.1' \
    --index-url https://download.pytorch.org/whl/cu124

# ---- 3. ultralytics 8.4.51 без зависимостей + явные deps ------------------
# `--no-deps` — чтобы не дёрнул свежий torch и не сломал pin выше.
# polars — для post-train hook ultralytics (без него падает в save_period
# при первой эпохе, см. README §типовые ошибки).
sudo -u ubuntu /opt/conda/bin/pip install --quiet --no-deps 'ultralytics==8.4.51'
sudo -u ubuntu /opt/conda/bin/pip install --quiet \
    'opencv-python-headless' 'pillow' 'pyyaml' 'tqdm' 'pandas' \
    'seaborn' 'matplotlib' 'psutil' 'py-cpuinfo' 'thop' 'scipy' \
    'requests' 'ultralytics-thop' 'polars'

# ---- 4. Sanity GPU + torch ------------------------------------------------
sudo -u ubuntu /opt/conda/bin/python - <<'PY'
import torch, ultralytics
print('torch', torch.__version__, 'cuda', torch.cuda.is_available(),
      'device', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no-cuda')
print('ultralytics', ultralytics.__version__)
PY

# ---- 5. Скачиваем датасет через instance-profile ---------------------------
# IAM роль kingside-gpu-pilot-role даёт s3:GetObject на datasets/board-recog/*.
sudo -u ubuntu aws s3 cp \
    "s3://kingside-ml/datasets/board-recog/${DATASET_TAR}" \
    "${NVME}/${DATASET_TAR}" \
    --region eu-central-1

# ---- 6. Распакуем ---------------------------------------------------------
sudo -u ubuntu tar -xf "${NVME}/${DATASET_TAR}" -C "${NVME}/data"
DATASET_DIR="${NVME}/data/${DATASET_TAR%.tar}"
ls -la "$DATASET_DIR" || true

# ---- 7. Патчим dataset.yaml на абсолютный path ----------------------------
# YOLO ultralytics использует `path:` как корень, относительные `train:` / `val:`
# тогда работают. В наших tar'ах path указывает на относительный './' — на
# инстансе чинить на абсолютный, чтобы команда yolo train запускалась из
# любого cwd.
if [ -f "${DATASET_DIR}/dataset.yaml" ]; then
    sudo -u ubuntu python3 - <<PY
import re, pathlib
p = pathlib.Path("${DATASET_DIR}/dataset.yaml")
txt = p.read_text()
txt = re.sub(r'^path:.*$', 'path: ${DATASET_DIR}', txt, flags=re.M)
p.write_text(txt)
print("--- patched dataset.yaml ---")
print(txt)
PY
fi

# ---- 8. Префетч yolov8n.pt -------------------------------------------------
# Чтобы первая команда yolo train не качала ~6 МБ из интернета.
sudo -u ubuntu /opt/conda/bin/python -c \
    "from ultralytics import YOLO; YOLO('yolov8n.pt')" || true

# ---- 9. READY-маркер -------------------------------------------------------
echo "READY $(date -Iseconds)" | sudo -u ubuntu tee "${NVME}/READY"
echo "=== kingside-gpu-pilot setup done: $(date -Iseconds) ==="
