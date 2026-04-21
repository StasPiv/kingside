#!/bin/bash
# Разворачивает self-hosted monitoring стек (Prometheus + Alertmanager + Grafana + postgres-exporter)
# на отдельном EC2-инстансе в VPC kingside-vpc (KS-1638).
#
# Идемпотентен: повторный запуск не создаёт дубликаты — проверяет по тегу Name=kingside-monitoring.
#
# Что делает:
#   1. Собирает tarball конфигов monitoring/ → kingside-frontend-<acct>/monitoring/configs.tar.gz.
#   2. Создаёт/подтверждает IAM-роль kingside-monitoring-ec2 (SSM + ECS read + SecretsManager read).
#   3. Создаёт SG kingside-monitoring-sg (inbound 22/3000/9090/9093 открытые; outbound all).
#   4. Обновляет kingside-ecs-sg: разрешает inbound 3001 от monitoring-sg.
#   5. Обновляет RDS SG sg-07c130de0992234e2: разрешает inbound 5432 от monitoring-sg.
#   6. Allocate Elastic IP (если ещё не allocate'н).
#   7. Launch EC2 t3.small Amazon Linux 2023 с user-data (scripts/monitoring/user-data.sh).
#   8. Associate Elastic IP с инстансом.
#   9. Выводит IP/DNS для доступа.
#
# Запуск:
#   bash scripts/monitoring/deploy-ec2.sh
#
# Удаление (обратная операция):
#   bash scripts/monitoring/deploy-ec2.sh --destroy

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID="342946498289"
VPC_ID="vpc-0d0d9344db8d11e7e"           # kingside-vpc (10.0.0.0/16)
PUBLIC_SUBNET_A="subnet-0374b32497e079707"  # kingside-public-a (10.0.1.0/24)
API_SG="sg-07f96fdb66b70e8eb"             # kingside-ecs-sg
RDS_SG="sg-07c130de0992234e2"
S3_BUCKET="kingside-frontend-${ACCOUNT_ID}"
CONFIGS_KEY="monitoring/configs.tar.gz"

SG_NAME="kingside-monitoring-sg"
ROLE_NAME="kingside-monitoring-ec2"
INSTANCE_PROFILE_NAME="kingside-monitoring-ec2"
INSTANCE_TAG="kingside-monitoring"
EIP_TAG="kingside-monitoring-eip"
INSTANCE_TYPE="t3.small"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

log() { echo "[$(date +%H:%M:%S)] $*"; }

# --- Destroy mode ---
if [ "${1:-}" = "--destroy" ]; then
    log "destroy mode"
    INSTANCE_ID=$(aws ec2 describe-instances --region "$REGION" \
        --filters "Name=tag:Name,Values=${INSTANCE_TAG}" "Name=instance-state-name,Values=running,stopped,stopping,pending" \
        --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null | head -1 || true)
    if [ -n "${INSTANCE_ID:-}" ] && [ "$INSTANCE_ID" != "None" ]; then
        log "terminating $INSTANCE_ID"
        aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID"
    fi
    EIP_ALLOC=$(aws ec2 describe-addresses --region "$REGION" \
        --filters "Name=tag:Name,Values=${EIP_TAG}" \
        --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)
    if [ -n "${EIP_ALLOC:-}" ] && [ "$EIP_ALLOC" != "None" ]; then
        log "releasing EIP $EIP_ALLOC"
        aws ec2 release-address --region "$REGION" --allocation-id "$EIP_ALLOC" || true
    fi
    log "destroy done (SG/IAM оставлены на случай повторного создания; удалить вручную при необходимости)"
    exit 0
fi

# --- 1. Tarball с конфигами в S3 ---
log "packing monitoring configs"
TMP_TAR=$(mktemp -t monitoring-configs.XXXX.tar.gz)
# ВАЖНО: тарим ОТНОСИТЕЛЬНЫЕ пути, без scripts/monitoring/ префикса.
tar -czf "$TMP_TAR" -C "$SCRIPT_DIR" \
    compose.monitoring.yml \
    prometheus \
    alertmanager \
    postgres-exporter \
    grafana \
    ecs-discovery
log "tarball: $(du -h "$TMP_TAR" | awk '{print $1}')"

log "uploading to s3://${S3_BUCKET}/${CONFIGS_KEY}"
aws s3 cp "$TMP_TAR" "s3://${S3_BUCKET}/${CONFIGS_KEY}" --region "$REGION"
rm -f "$TMP_TAR"

# --- 2. IAM Role + Instance Profile ---
log "ensuring IAM role $ROLE_NAME"
TRUST_POLICY=$(cat <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
)

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$TRUST_POLICY" \
        --description "KS-1638: EC2 role for kingside monitoring (Prometheus/Grafana)" >/dev/null
    log "created role $ROLE_NAME"
fi

# Managed policies
for POLICY_ARN in \
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" \
    "arn:aws:iam::aws:policy/AmazonECS_ReadOnlyAccess"; do
    aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN" 2>/dev/null || true
done

# Inline policy: Secrets Manager + S3 configs + SSM put-parameter для grafana-pwd
INLINE_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:kingside/api*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::${S3_BUCKET}/monitoring/*"
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:PutParameter", "ssm:GetParameter"],
      "Resource": "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/kingside/monitoring/*"
    },
    {
      "Effect": "Allow",
      "Action": ["ec2:DescribeNetworkInterfaces"],
      "Resource": "*"
    }
  ]
}
EOF
)
aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name kingside-monitoring-inline \
    --policy-document "$INLINE_POLICY"

# Instance profile
if ! aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" >/dev/null 2>&1; then
    aws iam create-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" >/dev/null
    aws iam add-role-to-instance-profile \
        --instance-profile-name "$INSTANCE_PROFILE_NAME" \
        --role-name "$ROLE_NAME"
    log "created instance profile $INSTANCE_PROFILE_NAME"
    log "waiting 10s for IAM propagation..."
    sleep 10
fi

# --- 3. Security Group ---
log "ensuring SG $SG_NAME"
SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-name,Values=${SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")

if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
    SG_ID=$(aws ec2 create-security-group --region "$REGION" \
        --group-name "$SG_NAME" \
        --description "KS-1638: Kingside monitoring stack (Prometheus/Grafana/AlertManager)" \
        --vpc-id "$VPC_ID" \
        --query 'GroupId' --output text)
    aws ec2 create-tags --region "$REGION" --resources "$SG_ID" \
        --tags Key=Name,Value="$SG_NAME"
    log "created SG $SG_ID"

    # Ingress — открытые порты UI. Admin может ограничить до своего IP вручную.
    # 22 SSH не открываем — используем SSM Session Manager.
    for PORT in 3000 9090 9093; do
        aws ec2 authorize-security-group-ingress --region "$REGION" \
            --group-id "$SG_ID" \
            --protocol tcp --port "$PORT" --cidr 0.0.0.0/0 >/dev/null
    done
    log "opened inbound: 3000 (Grafana), 9090 (Prometheus), 9093 (Alertmanager)"
else
    log "SG exists: $SG_ID"
fi

# --- 4. Разрешаем Prometheus → API (3001) и → RDS (5432) ---
log "patching $API_SG: inbound 3001 from $SG_ID"
aws ec2 authorize-security-group-ingress --region "$REGION" \
    --group-id "$API_SG" --protocol tcp --port 3001 \
    --source-group "$SG_ID" 2>/dev/null || log "  (rule already exists)"

log "patching $RDS_SG: inbound 5432 from $SG_ID"
aws ec2 authorize-security-group-ingress --region "$REGION" \
    --group-id "$RDS_SG" --protocol tcp --port 5432 \
    --source-group "$SG_ID" 2>/dev/null || log "  (rule already exists)"

# --- 5. Elastic IP ---
log "ensuring Elastic IP tagged $EIP_TAG"
EIP_ALLOC=$(aws ec2 describe-addresses --region "$REGION" \
    --filters "Name=tag:Name,Values=${EIP_TAG}" \
    --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo "None")

if [ "$EIP_ALLOC" = "None" ] || [ -z "$EIP_ALLOC" ]; then
    # используем --query вместо jq, т.к. jq может отсутствовать в окружении запуска
    EIP_ALLOC=$(aws ec2 allocate-address --region "$REGION" --domain vpc \
        --query 'AllocationId' --output text)
    EIP_ADDR=$(aws ec2 describe-addresses --region "$REGION" \
        --allocation-ids "$EIP_ALLOC" --query 'Addresses[0].PublicIp' --output text)
    aws ec2 create-tags --region "$REGION" --resources "$EIP_ALLOC" \
        --tags Key=Name,Value="$EIP_TAG"
    log "allocated EIP: $EIP_ADDR ($EIP_ALLOC)"
else
    EIP_ADDR=$(aws ec2 describe-addresses --region "$REGION" \
        --allocation-ids "$EIP_ALLOC" --query 'Addresses[0].PublicIp' --output text)
    log "EIP exists: $EIP_ADDR ($EIP_ALLOC)"
fi

# --- 6. Instance ---
log "checking existing instance tagged Name=${INSTANCE_TAG}"
EXISTING=$(aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Name,Values=${INSTANCE_TAG}" "Name=instance-state-name,Values=running,pending" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null || true)

if [ -n "${EXISTING:-}" ] && [ "$EXISTING" != "None" ]; then
    log "instance already running: $EXISTING"
    INSTANCE_ID="$EXISTING"
else
    log "finding latest Amazon Linux 2023 AMI"
    AMI_ID=$(aws ec2 describe-images --region "$REGION" \
        --owners amazon \
        --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
        --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)
    log "AMI: $AMI_ID"

    log "launching $INSTANCE_TYPE instance"
    INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" \
        --image-id "$AMI_ID" \
        --instance-type "$INSTANCE_TYPE" \
        --subnet-id "$PUBLIC_SUBNET_A" \
        --security-group-ids "$SG_ID" \
        --iam-instance-profile "Name=$INSTANCE_PROFILE_NAME" \
        --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}' \
        --user-data "file://$SCRIPT_DIR/user-data.sh" \
        --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=2' \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${INSTANCE_TAG}},{Key=Project,Value=kingside},{Key=Component,Value=monitoring}]" \
        --query 'Instances[0].InstanceId' --output text)
    log "launched: $INSTANCE_ID (bootstrap ~5 мин; логи в /var/log/kingside-monitoring-bootstrap.log)"

    log "waiting for instance running..."
    aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
fi

# --- 7. Associate EIP ---
log "associating EIP $EIP_ADDR with $INSTANCE_ID"
aws ec2 associate-address --region "$REGION" \
    --instance-id "$INSTANCE_ID" \
    --allocation-id "$EIP_ALLOC" >/dev/null

# --- 8. Summary ---
cat <<EOF

=== KS-1638 deploy summary ===
Region:          $REGION
VPC:             $VPC_ID
Subnet:          $PUBLIC_SUBNET_A
SG monitoring:   $SG_ID
IAM role:        $ROLE_NAME
Instance:        $INSTANCE_ID ($INSTANCE_TYPE)
Elastic IP:      $EIP_ADDR
Bootstrap log:   ssm start-session --target $INSTANCE_ID  →  sudo tail -f /var/log/kingside-monitoring-bootstrap.log
Grafana:         http://$EIP_ADDR:3000   (admin / password из SSM parameter /kingside/monitoring/grafana_admin_password)
Prometheus:      http://$EIP_ADDR:9090
Alertmanager:    http://$EIP_ADDR:9093
==============================
EOF

log "done"
