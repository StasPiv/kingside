#!/bin/bash
# scripts/ml-training/yolo-gpu/teardown.sh
#
# Гасит GPU-инстанс и сносит ВЕСЬ AWS-обвес, созданный setup-aws.sh.
# Запускать СРАЗУ после окончания тренировки — on-demand $0.526/час идёт
# нон-стоп пока инстанс жив.
#
# Без аргументов читает instance-id из /tmp/kingside-gpu-pilot.id.
# Передай явно если файла нет:  ./teardown.sh i-XXXXXXXXXXXXXXXXX

set -uo pipefail

REGION="eu-central-1"
KEY_NAME="kingside-gpu-pilot"
SG_NAME="kingside-gpu-pilot"
ROLE_NAME="kingside-gpu-pilot-role"
PROFILE_NAME="kingside-gpu-pilot-profile"
POLICY_NAME="s3-read-board-recog"
ID_PATH="/tmp/${KEY_NAME}.id"
SG_ID_PATH="/tmp/${KEY_NAME}.sg"
KEY_PATH="/tmp/${KEY_NAME}.pem"
IP_PATH="/tmp/${KEY_NAME}.ip"

INSTANCE_ID="${1:-}"
if [ -z "$INSTANCE_ID" ] && [ -f "$ID_PATH" ]; then
    INSTANCE_ID=$(cat "$ID_PATH")
fi

# ---- 1. terminate instance -------------------------------------------------
if [ -n "$INSTANCE_ID" ]; then
    echo "=== terminate $INSTANCE_ID ==="
    aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION" \
        --query 'TerminatingInstances[0].[InstanceId, CurrentState.Name, PreviousState.Name]' \
        --output table 2>&1 || true
    echo "[wait] instance-terminated..."
    aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID" --region "$REGION" || true
    echo "[done] $INSTANCE_ID terminated"
else
    echo "[skip] instance-id не задан и $ID_PATH отсутствует — пропускаю terminate"
fi

# ---- 2. SG -----------------------------------------------------------------
SG_ID=""
if [ -f "$SG_ID_PATH" ]; then
    SG_ID=$(cat "$SG_ID_PATH")
fi
if [ -z "$SG_ID" ]; then
    SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
        --filters "Name=group-name,Values=${SG_NAME}" \
        --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
fi
if [ -n "$SG_ID" ] && [ "$SG_ID" != "None" ]; then
    aws ec2 delete-security-group --group-id "$SG_ID" --region "$REGION" 2>&1 \
        && echo "[sg] $SG_ID deleted" \
        || echo "[sg] WARN: delete-security-group упал (возможно ENI ещё цепляется, повтори через 30с)"
fi

# ---- 3. IAM cleanup --------------------------------------------------------
aws iam remove-role-from-instance-profile \
    --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME" 2>/dev/null \
    && echo "[iam] role removed from instance-profile" \
    || true
aws iam delete-instance-profile --instance-profile-name "$PROFILE_NAME" 2>/dev/null \
    && echo "[iam] instance-profile $PROFILE_NAME deleted" \
    || true
aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" 2>/dev/null \
    && echo "[iam] inline policy $POLICY_NAME removed" \
    || true
aws iam delete-role --role-name "$ROLE_NAME" 2>/dev/null \
    && echo "[iam] role $ROLE_NAME deleted" \
    || true

# ---- 4. keypair ------------------------------------------------------------
aws ec2 delete-key-pair --key-name "$KEY_NAME" --region "$REGION" 2>/dev/null \
    && echo "[keypair] AWS-side keypair $KEY_NAME deleted" \
    || true

# ---- 5. локальные tmp-файлы ------------------------------------------------
rm -f "$ID_PATH" "$SG_ID_PATH" "$KEY_PATH" "$IP_PATH" /tmp/gpu-user-data.sh
echo "[local] /tmp/${KEY_NAME}.* и /tmp/gpu-user-data.sh подчищены"

echo
echo "=== teardown done ==="
