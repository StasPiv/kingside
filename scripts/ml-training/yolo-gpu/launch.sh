#!/bin/bash
# scripts/ml-training/yolo-gpu/launch.sh
#
# Запускает g4dn.xlarge для тренировки YOLO под указанный датасет.
# Перед запуском должен быть выполнен setup-aws.sh.
#
# Аргумент: <DATASET> — имя без расширения (e.g. v4-objdet, v5-findboards).
#                       На S3 должен лежать s3://kingside-ml/datasets/board-recog/<DATASET>.tar
#
# По завершении печатает SSH-команду и реквизиты для backend.

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <DATASET>" >&2
    echo "  e.g. $0 v4-objdet" >&2
    echo "       $0 v5-findboards" >&2
    exit 1
fi
DATASET="$1"
DATASET_TAR="${DATASET}.tar"

REGION="eu-central-1"
AMI_ID="ami-03aa80bc63bbd3638"
INSTANCE_TYPE="g4dn.xlarge"
KEY_NAME="kingside-gpu-pilot"
SG_ID_PATH="/tmp/${KEY_NAME}.sg"
KEY_PATH="/tmp/${KEY_NAME}.pem"
TEMPLATE="$(dirname "$0")/user-data.sh"

# ---- preflight -------------------------------------------------------------
[ -f "$SG_ID_PATH" ] || { echo "ERROR: $SG_ID_PATH не найден — сначала запусти ./setup-aws.sh" >&2; exit 1; }
[ -f "$KEY_PATH" ]  || { echo "ERROR: $KEY_PATH не найден — сначала запусти ./setup-aws.sh" >&2; exit 1; }
[ -f "$TEMPLATE" ]  || { echo "ERROR: $TEMPLATE не найден" >&2; exit 1; }
SG_ID=$(cat "$SG_ID_PATH")

# Проверка что tar реально лежит в S3 — без неё инстанс упадёт в user-data
# через 1 минуту, и мы заплатим $0.01 ни за что.
if ! aws s3api head-object --bucket kingside-ml \
        --key "datasets/board-recog/${DATASET_TAR}" \
        --region "$REGION" >/dev/null 2>&1; then
    echo "ERROR: s3://kingside-ml/datasets/board-recog/${DATASET_TAR} не существует." >&2
    echo "       Залей tar в S3 перед запуском, см. README §0." >&2
    exit 1
fi

# ---- собрать user-data из template -----------------------------------------
USER_DATA_PATH="/tmp/gpu-user-data.sh"
sed "s|__DATASET_TAR__|${DATASET_TAR}|g" "$TEMPLATE" > "$USER_DATA_PATH"
echo "[user-data] generated $USER_DATA_PATH for tar=${DATASET_TAR}"

# ---- run-instances ---------------------------------------------------------
echo "[launch] aws ec2 run-instances on-demand g4dn.xlarge in ${REGION}..."
INSTANCE_JSON=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --iam-instance-profile "Name=kingside-gpu-pilot-profile" \
    --user-data "fileb://${USER_DATA_PATH}" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=120,VolumeType=gp3,DeleteOnTermination=true}' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${KEY_NAME}},{Key=Project,Value=kingside},{Key=Purpose,Value=${DATASET}-yolo-train}]" \
    --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=2' \
    --output json)
INSTANCE_ID=$(echo "$INSTANCE_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['Instances'][0]['InstanceId'])")
echo "$INSTANCE_ID" > "/tmp/${KEY_NAME}.id"
echo "[launch] instance: $INSTANCE_ID"

# ---- ждать running ---------------------------------------------------------
echo "[wait] running..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"
IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --region "$REGION" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "$IP" > "/tmp/${KEY_NAME}.ip"
echo "[launch] public IP: $IP"

# ---- ждать READY-маркер ----------------------------------------------------
# user-data может работать 3–6 минут (pip install + s3 cp + tar -xf).
# Считаем READY = SSH доступен + файл /opt/dlami/nvme/READY существует.
echo "[wait] /opt/dlami/nvme/READY (timeout 10 min)..."
DEADLINE=$(( $(date +%s) + 600 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if ssh -i "$KEY_PATH" \
           -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
           -o ConnectTimeout=5 -o BatchMode=yes \
           "ubuntu@${IP}" 'test -f /opt/dlami/nvme/READY' 2>/dev/null; then
        echo "[ready] READY-маркер найден"
        break
    fi
    sleep 10
done

if ! ssh -i "$KEY_PATH" \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o ConnectTimeout=5 -o BatchMode=yes \
        "ubuntu@${IP}" 'test -f /opt/dlami/nvme/READY' 2>/dev/null; then
    echo "ERROR: READY-маркер так и не появился за 10 мин. Проверь:" >&2
    echo "  ssh -i $KEY_PATH ubuntu@${IP} 'sudo tail -100 /var/log/kingside-setup.log'" >&2
    exit 2
fi

# ---- отчёт -----------------------------------------------------------------
cat <<EOF

=== READY ===

Instance:  $INSTANCE_ID
Public IP: $IP
SSH key:   $KEY_PATH
Dataset:   /opt/dlami/nvme/data/${DATASET}/  (from ${DATASET_TAR})

SSH:
  ssh -i $KEY_PATH \\
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
      ubuntu@${IP}

Smoke (1 эпоха для проверки):
  ssh -i $KEY_PATH ubuntu@${IP} \\
    '/opt/conda/bin/yolo train \\
       data=/opt/dlami/nvme/data/${DATASET}/dataset.yaml \\
       model=yolov8n.pt epochs=1 imgsz=512 batch=16 \\
       device=0 workers=4 cache=ram \\
       project=/opt/dlami/nvme/runs name=smoke \\
       patience=20 plots=False save_period=1 seed=2026 exist_ok=True'

Full train (epochs/name под задачу):
  ssh -i $KEY_PATH ubuntu@${IP} \\
    '/opt/conda/bin/yolo train \\
       data=/opt/dlami/nvme/data/${DATASET}/dataset.yaml \\
       model=yolov8n.pt epochs=8 imgsz=512 batch=16 \\
       device=0 workers=4 cache=ram \\
       project=/opt/dlami/nvme/runs name=<RUN_NAME> \\
       patience=20 plots=False save_period=1 seed=2026 exist_ok=True'

Export ONNX:
  ssh -i $KEY_PATH ubuntu@${IP} \\
    '/opt/conda/bin/yolo export \\
       model=/opt/dlami/nvme/runs/<RUN_NAME>/weights/best.pt \\
       format=onnx imgsz=512 simplify=True'

Pull artifacts:
  scp -i $KEY_PATH \\
      ubuntu@${IP}:'/opt/dlami/nvme/runs/<RUN_NAME>/weights/*' \\
      /tmp/<RUN_NAME>-yolo-gpu/

Teardown (ОБЯЗАТЕЛЬНО — иначе on-demand идёт):
  $(dirname "$0")/teardown.sh

EOF
