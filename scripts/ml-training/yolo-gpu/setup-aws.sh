#!/bin/bash
# scripts/ml-training/yolo-gpu/setup-aws.sh
#
# Идемпотентный setup AWS-обвеса для разовой GPU-тренировки YOLO
# (KS-3091 / KS-3110). Создаёт keypair, security group, IAM role
# и instance profile. Снятие — teardown.sh.
#
# Что создаётся:
#   keypair         kingside-gpu-pilot
#   sg              kingside-gpu-pilot (ingress 22/tcp с текущего внешнего IP)
#   iam role        kingside-gpu-pilot-role + inline policy s3-read-board-recog
#   iam instance-profile kingside-gpu-pilot-profile (-> role)
#
# Локальные файлы (нужны launch.sh):
#   /tmp/kingside-gpu-pilot.pem  — приватный ключ ed25519 (chmod 600)
#   /tmp/kingside-gpu-pilot.sg   — id security group
#
# Регион eu-central-1 захардкожен — мы вообще в нём работаем.

set -euo pipefail

REGION="eu-central-1"
KEY_NAME="kingside-gpu-pilot"
SG_NAME="kingside-gpu-pilot"
ROLE_NAME="kingside-gpu-pilot-role"
PROFILE_NAME="kingside-gpu-pilot-profile"
POLICY_NAME="s3-read-board-recog"
KEY_PATH="/tmp/${KEY_NAME}.pem"
SG_ID_PATH="/tmp/${KEY_NAME}.sg"

echo "=== setup-aws.sh: ensure infra for ${KEY_NAME}, region ${REGION} ==="

# ---- 1. keypair ------------------------------------------------------------
if aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null 2>&1; then
    echo "[keypair] already exists in AWS"
    if [ ! -f "$KEY_PATH" ]; then
        echo "[keypair] WARN: AWS-side keypair есть, но локального ${KEY_PATH} нет."
        echo "                 Без приватника подключиться не сможем — пересоздаю."
        aws ec2 delete-key-pair --region "$REGION" --key-name "$KEY_NAME" >/dev/null
        aws ec2 create-key-pair --region "$REGION" --key-name "$KEY_NAME" \
            --key-type ed25519 --key-format pem \
            --query 'KeyMaterial' --output text > "$KEY_PATH"
        chmod 600 "$KEY_PATH"
        echo "[keypair] recreated, private key at $KEY_PATH"
    fi
else
    aws ec2 create-key-pair --region "$REGION" --key-name "$KEY_NAME" \
        --key-type ed25519 --key-format pem \
        --query 'KeyMaterial' --output text > "$KEY_PATH"
    chmod 600 "$KEY_PATH"
    echo "[keypair] created, private key at $KEY_PATH"
fi

# ---- 2. security group ------------------------------------------------------
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
    --filters Name=is-default,Values=true \
    --query 'Vpcs[0].VpcId' --output text)
if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
    echo "ERROR: default VPC не найден в $REGION" >&2
    exit 1
fi

SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-name,Values=${SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")

if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
    SG_ID=$(aws ec2 create-security-group --region "$REGION" \
        --group-name "$SG_NAME" \
        --description "Kingside GPU pilot SSH-only" \
        --vpc-id "$VPC_ID" \
        --query 'GroupId' --output text)
    echo "[sg] created: $SG_ID"
else
    echo "[sg] already exists: $SG_ID"
fi
echo "$SG_ID" > "$SG_ID_PATH"

# Текущий внешний IP. Если ifconfig.me недоступен — упасть, не открывать на весь свет.
MY_IP=$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)
if [[ ! "$MY_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: не удалось определить внешний IP через ifconfig.me. SSH-rule не добавлю." >&2
    echo "        Передай IP вручную или открой 22/tcp руками после ревью." >&2
    exit 1
fi
MY_CIDR="${MY_IP}/32"

if aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" \
    --query "SecurityGroups[0].IpPermissions[?ToPort==\`22\`].IpRanges[?CidrIp==\`${MY_CIDR}\`]" \
    --output text 2>/dev/null | grep -q "$MY_IP"; then
    echo "[sg] ingress 22/tcp от ${MY_CIDR} уже есть"
else
    aws ec2 authorize-security-group-ingress --region "$REGION" \
        --group-id "$SG_ID" --protocol tcp --port 22 --cidr "$MY_CIDR" >/dev/null
    echo "[sg] ingress 22/tcp от ${MY_CIDR} добавлен"
fi

# ---- 3. IAM role + inline policy -------------------------------------------
TRUST_DOC='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
S3_DOC='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:ListBucket"],"Resource":["arn:aws:s3:::kingside-ml","arn:aws:s3:::kingside-ml/datasets/board-recog/*"]}]}'

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    echo "[iam] role $ROLE_NAME already exists"
else
    aws iam create-role --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$TRUST_DOC" >/dev/null
    echo "[iam] role $ROLE_NAME created"
fi

# policy кладём/обновляем безусловно — содержимое детерминированно
aws iam put-role-policy --role-name "$ROLE_NAME" \
    --policy-name "$POLICY_NAME" \
    --policy-document "$S3_DOC"
echo "[iam] inline policy $POLICY_NAME applied"

# ---- 4. instance profile ---------------------------------------------------
if aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
    echo "[iam] instance-profile $PROFILE_NAME already exists"
else
    aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null
    echo "[iam] instance-profile $PROFILE_NAME created"
fi

ATTACHED=$(aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" \
    --query 'InstanceProfile.Roles[0].RoleName' --output text 2>/dev/null || echo "None")
if [ "$ATTACHED" != "$ROLE_NAME" ]; then
    if [ "$ATTACHED" != "None" ] && [ -n "$ATTACHED" ]; then
        aws iam remove-role-from-instance-profile \
            --instance-profile-name "$PROFILE_NAME" --role-name "$ATTACHED" >/dev/null
        echo "[iam] detached stale role $ATTACHED from profile"
    fi
    aws iam add-role-to-instance-profile \
        --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME" >/dev/null
    echo "[iam] $ROLE_NAME attached to $PROFILE_NAME"
fi

# ---- 5. eventual consistency пауза -----------------------------------------
# Без этого первый run-instances иногда ловит
# `InvalidIAMInstanceProfile.NotFound`. AWS IAM-control-plane может лагать 10–15с.
echo "[wait] 10s for IAM eventual consistency..."
sleep 10

echo
echo "=== setup-aws.sh done ==="
echo "  keypair:          ${KEY_NAME} (private at ${KEY_PATH})"
echo "  security group:   ${SG_ID}  (ssh:22 from ${MY_CIDR})"
echo "  iam role:         ${ROLE_NAME}"
echo "  instance profile: ${PROFILE_NAME}"
echo
echo "Next:  ./launch.sh <DATASET>   (e.g. v4-objdet, v5-findboards)"
