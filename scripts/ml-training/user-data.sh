#!/bin/bash
# KS-3071 / KS-3073 runbook §3.4 — EC2 user-data для разовой GPU-тренировки.
# AMI: AWS Deep Learning Base GPU Nvidia Driver AMI (Ubuntu 22.04).
# Стратегия: НИКАКОГО apt install. Тренировка идёт ВНУТРИ
# `pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime` через `docker run --gpus all`.

set -euxo pipefail

# (0) Лог в файл + системную консоль — для последующего разбора.
exec > >(tee -a /var/log/user-data.log /dev/console) 2>&1

# (1) Гарантия терминирования при ЛЮБОМ выходе скрипта (успех / ошибка).
#     RunInstances вызывается с InstanceInitiatedShutdownBehavior=terminate,
#     так что shutdown превращается в terminate.
trap 'shutdown -h now' EXIT

# (2) Идентификаторы.
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)
RUN_ID="v1.0.0-$(date -u +%Y%m%dT%H%M%SZ)"
echo "instance=$INSTANCE_ID run=$RUN_ID"

# (3) Sanity host: docker + GPU.
docker --version
nvidia-smi -L
# nvidia-container-toolkit smoke-test (на DLAMI должен быть из коробки).
docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi -L

# (4) Pull artefacts.
mkdir -p /opt/work
aws s3 cp s3://kingside-ml/_tmp/board-recog-training.tar.gz /opt/work/code.tar.gz
aws s3 cp s3://kingside-ml/_tmp/board-recog-bootstrap.sh /opt/work/bootstrap.sh
chmod +x /opt/work/bootstrap.sh

# (5) Полный тренинг внутри pytorch-образа. Хост не трогаем.
docker run --rm --gpus all \
    --shm-size=2g \
    -e RUN_ID="$RUN_ID" \
    -v /opt/work:/work \
    pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime \
    bash /work/bootstrap.sh

# (6) На всякий — синхронно сбросить user-data.log в S3, чтобы потом можно
#     было читать post-mortem без живого инстанса.
aws s3 cp /var/log/user-data.log "s3://kingside-ml/_tmp/runs/$RUN_ID/user-data.log" || true

echo "[done] $RUN_ID"
# EXIT trap → shutdown -h now → AWS terminate.
