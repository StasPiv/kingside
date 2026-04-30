#!/usr/bin/env bash
# KS-2195: Synthetic v2 — bootstrap ECS-инфраструктуры apps/synthetic-bot-service.
#
# Идемпотентный скрипт. Повторные запуски безопасны: каждый шаг проверяет
# существующее состояние и пропускает уже настроенное.
#
# Связанные ADR: ADR-034-v2 §1.3, §4, §7.2, §10.5.
# Образец — broadcast/archive (scripts/broadcast-service-aws-setup.sh,
# scripts/archive-service-aws-setup.sh).
#
# Что настраивает:
#   - ECR repo kingside-synthetic-bot-service.
#   - CloudWatch log group /kingside/synthetic-bot-service (retention 30d).
#   - SSM SecureString /kingside/synthetic-bot/internal-key (random 32 байта,
#     base64). Тот же ключ позже инжектится в apps/api task-def
#     (InternalKeyGuard) — sync вручную после первого запуска (см. KS-2186).
#   - Security group kingside-synthetic-bot-sg в VPC kingside (outbound only,
#     inbound пусто — сервис исходящий).
#   - Ingress на kingside-redis-sg :6379 от kingside-synthetic-bot-sg.
#   - ECS task definition kingside-synthetic-bot-service
#     (FARGATE, 2048 CPU / 2048 MiB, stopTimeout=120, no portMappings).
#   - ECS service kingside-synthetic-bot-service (desired=1, без ALB target
#     group, placement в одной AZ — eu-central-1a per ADR §7.2).
#   - Application Auto Scaling target (min=1, max=3) и target-tracking policy
#     по custom CloudWatch метрике Kingside/SyntheticBot/synth_tasks_total_active
#     (target=25, cooldown 300/300).
#
# Что НЕ делает:
#   - Docker build/push — это в scripts/deploy-synthetic-bot.sh (или
#     scripts/deploy-aws.sh scope=synthetic-bot).
#   - Sync SYNTHETIC_BOT_INTERNAL_KEY в apps/api task-def — отдельный шаг,
#     KS-2186 (Av1 InternalKeyGuard).
#
# Предпосылки:
#   - VPC kingside (vpc-0d0d9344db8d11e7e), subnets / SG kingside-redis-sg
#     уже существуют. AWS creds — kingside-ci.
#   - Образ kingside-synthetic-bot-service:latest в ECR — ДЛЯ register-task-def
#     и create-service. Если нет, скрипт регистрирует ECR/SSM/CW/SG и выходит
#     до task-def. Сначала backend/devops пушит первый build:
#       scripts/deploy-synthetic-bot.sh
#     потом скрипт повторно — он добавит task-def + service.

set -euo pipefail

REGION="${REGION:-eu-central-1}"
ACCOUNT_ID="${ACCOUNT_ID:-342946498289}"
CLUSTER="${CLUSTER:-kingside}"
SERVICE_NAME="${SERVICE_NAME:-kingside-synthetic-bot-service}"
TASK_FAMILY="${TASK_FAMILY:-kingside-synthetic-bot-service}"
ECR_REPO_NAME="${ECR_REPO_NAME:-kingside-synthetic-bot-service}"
LOG_GROUP="${LOG_GROUP:-/kingside/synthetic-bot-service}"
VPC_ID="${VPC_ID:-vpc-0d0d9344db8d11e7e}"
REDIS_SG="${REDIS_SG:-sg-0d21ef8e5abcdf623}"
# ADR §7.2: одна AZ. eu-central-1a — где сидят api/game/archive/broadcast.
SUBNET_ID="${SUBNET_ID:-subnet-0374b32497e079707}"
API_SECRET_ARN="${API_SECRET_ARN:-arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:kingside/api-nfkTKX}"
SSM_PARAM_NAME="${SSM_PARAM_NAME:-/kingside/synthetic-bot/internal-key}"
SSM_PARAM_ARN="arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${SSM_PARAM_NAME}"
ECR_IMAGE="${ECR_IMAGE:-${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO_NAME}:latest}"
HEALTH_PORT="${HEALTH_PORT:-3010}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
DESIRED_COUNT_INITIAL="${DESIRED_COUNT_INITIAL:-1}"
AUTOSCALE_MIN="${AUTOSCALE_MIN:-1}"
AUTOSCALE_MAX="${AUTOSCALE_MAX:-3}"
AUTOSCALE_TARGET="${AUTOSCALE_TARGET:-25}"
METRIC_NAMESPACE="${METRIC_NAMESPACE:-Kingside/SyntheticBot}"
METRIC_NAME="${METRIC_NAME:-synth_tasks_total_active}"

aws_cli() { aws --region "${REGION}" "$@"; }
log() { printf '[synthetic-bot-setup] %s\n' "$*"; }

# --- 1. ECR repository ---
set +e
ECR_EXISTS=$(aws_cli ecr describe-repositories --repository-names "${ECR_REPO_NAME}" \
    --query 'repositories[0].repositoryUri' --output text 2>/dev/null)
set -e
if [ -z "${ECR_EXISTS}" ] || [ "${ECR_EXISTS}" = "None" ]; then
    log "creating ECR repo ${ECR_REPO_NAME}"
    aws_cli ecr create-repository --repository-name "${ECR_REPO_NAME}" \
        --image-scanning-configuration scanOnPush=true \
        --image-tag-mutability MUTABLE \
        --query 'repository.repositoryUri' --output text
else
    log "ECR repo ${ECR_REPO_NAME} exists: ${ECR_EXISTS}"
fi

# --- 2. CloudWatch log group ---
LG_EXISTS=$(aws_cli logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" \
    --query "logGroups[?logGroupName=='${LOG_GROUP}'] | [0].logGroupName" --output text)
if [ -z "${LG_EXISTS}" ] || [ "${LG_EXISTS}" = "None" ]; then
    log "creating log group ${LOG_GROUP}"
    aws_cli logs create-log-group --log-group-name "${LOG_GROUP}"
else
    log "log group ${LOG_GROUP} exists"
fi
aws_cli logs put-retention-policy --log-group-name "${LOG_GROUP}" --retention-in-days 30 || \
    log "WARN: PutRetentionPolicy on ${LOG_GROUP} failed — check kingside-ci permissions"

# --- 3. SSM SecureString — internal key (32 random bytes, base64) ---
set +e
SSM_EXISTS=$(aws_cli ssm get-parameter --name "${SSM_PARAM_NAME}" \
    --query 'Parameter.Name' --output text 2>/dev/null)
set -e
if [ -z "${SSM_EXISTS}" ] || [ "${SSM_EXISTS}" = "None" ]; then
    log "creating SSM SecureString ${SSM_PARAM_NAME} (random 32 bytes)"
    SECRET_VAL=$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | tr '/+' '_-')
    aws_cli ssm put-parameter \
        --name "${SSM_PARAM_NAME}" \
        --description "KS-2195: shared internal key for synthetic-bot ↔ api InternalKeyGuard. Set in api task-def (KS-2186)." \
        --type SecureString \
        --value "${SECRET_VAL}" \
        --tier Standard \
        --query 'Version' --output text
    log "SSM ${SSM_PARAM_NAME} created. Sync this value into apps/api task-def (KS-2186)."
else
    log "SSM ${SSM_PARAM_NAME} exists"
fi

# --- 4. Security group kingside-synthetic-bot-sg ---
set +e
BOT_SG=$(aws_cli ec2 describe-security-groups \
    --filters "Name=vpc-id,Values=${VPC_ID}" "Name=group-name,Values=kingside-synthetic-bot-sg" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)
set -e
if [ -z "${BOT_SG}" ] || [ "${BOT_SG}" = "None" ]; then
    log "creating SG kingside-synthetic-bot-sg in ${VPC_ID}"
    BOT_SG=$(aws_cli ec2 create-security-group \
        --group-name kingside-synthetic-bot-sg \
        --description "KS-2195 ADR-034-v2 sec 10.5 outbound-only SG for synthetic-bot-service" \
        --vpc-id "${VPC_ID}" \
        --query 'GroupId' --output text)
    log "created SG: ${BOT_SG}"
    # Default outbound (allow all) уже создаётся AWS — менять не надо.
    # Inbound пусто — bot-service не принимает соединений.
else
    log "SG kingside-synthetic-bot-sg exists: ${BOT_SG}"
fi

# --- 5. Ingress в kingside-redis-sg :6379 от bot-sg ---
set +e
SG_OUT=$(aws_cli ec2 authorize-security-group-ingress \
    --group-id "${REDIS_SG}" \
    --ip-permissions "IpProtocol=tcp,FromPort=6379,ToPort=6379,UserIdGroupPairs=[{GroupId=${BOT_SG},Description=\"synthetic-bot-service redis access\"}]" \
    2>&1)
SG_RC=$?
set -e
if [ ${SG_RC} -eq 0 ]; then
    log "added ingress TCP:6379 from ${BOT_SG} → ${REDIS_SG}"
elif echo "${SG_OUT}" | grep -q "InvalidPermission.Duplicate"; then
    log "ingress TCP:6379 from ${BOT_SG} → ${REDIS_SG} already present"
else
    echo "${SG_OUT}" >&2
    exit ${SG_RC}
fi

# Связность с api/game/archive: bot-service ходит через публичные ALB-домены
# (api.kingside.site, game.kingside.site, archive.kingside.site). На SG никаких
# дополнительных правил не нужно — outbound :443 разрешён по умолчанию,
# а ALB уже принимает 0.0.0.0/0 на 80/443. Direct-VPC service discovery
# (Cloud Map / ECS Service Connect) — будущая оптимизация, не делается сейчас.

# --- 6. ECS Task definition (только если образ :latest пушнут в ECR) ---
set +e
IMAGE_CHECK=$(aws_cli ecr describe-images --repository-name "${ECR_REPO_NAME}" \
    --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text 2>/dev/null)
set -e
if [ -z "${IMAGE_CHECK}" ] || [ "${IMAGE_CHECK}" = "None" ]; then
    log "WARN: ECR image ${ECR_REPO_NAME}:latest не найден — пропускаем register-task-def + create-service."
    log "      Сначала запусти scripts/deploy-synthetic-bot.sh для первого билда+пуша,"
    log "      затем повторно scripts/synthetic-bot-aws-setup.sh — он добавит task-def + service."
    log "Bootstrap (ECR/SSM/CW/SG) завершён. SG=${BOT_SG}"
    exit 0
fi

# Health-check: задача требует "curl -f http://localhost:3010/health". В image
# базе node:22-bookworm curl не гарантирован (есть в bookworm-full, но не в
# slim). Используем node-inline — он 100% есть, семантика та же.
HC_CMD="node -e \"const h=require('http');h.get('http://localhost:${HEALTH_PORT}${HEALTH_PATH}',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))\""

TASKDEF_JSON=$(cat <<EOF
{
  "family": "${TASK_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "2048",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskRole",
  "containerDefinitions": [
    {
      "name": "${TASK_FAMILY}",
      "image": "${ECR_IMAGE}",
      "essential": true,
      "stopTimeout": 120,
      "environment": [
        {"name": "NODE_ENV", "value": "production"},
        {"name": "HEALTH_PORT", "value": "${HEALTH_PORT}"},
        {"name": "GAME_SERVICE_WS_URL", "value": "wss://game.kingside.site"},
        {"name": "API_INTERNAL_URL", "value": "https://api.kingside.site"},
        {"name": "ARCHIVE_SERVICE_URL", "value": "https://archive.kingside.site"},
        {"name": "STOCKFISH_PATH", "value": "/usr/games/stockfish"},
        {"name": "STOCKFISH_POOL_SIZE", "value": "3"},
        {"name": "BOT_INSTANCE_LIMIT_PER_TASK", "value": "30"},
        {"name": "SYNTHETIC_SCHEDULER_ENABLED", "value": "true"},
        {"name": "TASK_SHARD_COUNT", "value": "1"},
        {"name": "METRIC_NAMESPACE", "value": "${METRIC_NAMESPACE}"},
        {"name": "METRIC_NAME", "value": "${METRIC_NAME}"}
      ],
      "secrets": [
        {"name": "SYNTHETIC_BOT_INTERNAL_KEY", "valueFrom": "${SSM_PARAM_ARN}"},
        {"name": "REDIS_URL",  "valueFrom": "${API_SECRET_ARN}:REDIS_URL::"},
        {"name": "REDIS_HOST", "valueFrom": "${API_SECRET_ARN}:REDIS_HOST::"},
        {"name": "REDIS_PORT", "valueFrom": "${API_SECRET_ARN}:REDIS_PORT::"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${LOG_GROUP}",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "${HC_CMD}"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
EOF
)
TASKDEF_FILE="$(mktemp -t synth-bot-taskdef.XXXXXX.json)"
trap 'rm -f "${TASKDEF_FILE}"' EXIT
printf '%s' "${TASKDEF_JSON}" > "${TASKDEF_FILE}"
TD_ARN=$(aws_cli ecs register-task-definition --cli-input-json "file://${TASKDEF_FILE}" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
log "registered task definition: ${TD_ARN}"

# --- 7. ECS service ---
SVC_STATUS=$(aws_cli ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE_NAME}" \
    --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")

if [ "${SVC_STATUS}" = "ACTIVE" ]; then
    log "service ${SERVICE_NAME} exists → update to ${TD_ARN}"
    aws_cli ecs update-service --cluster "${CLUSTER}" --service "${SERVICE_NAME}" \
        --task-definition "${TD_ARN}" --force-new-deployment \
        --query 'service.deployments[0].status' --output text
else
    log "creating service ${SERVICE_NAME} (desired=${DESIRED_COUNT_INITIAL}, no ALB)"
    aws_cli ecs create-service \
        --cluster "${CLUSTER}" \
        --service-name "${SERVICE_NAME}" \
        --task-definition "${TD_ARN}" \
        --desired-count "${DESIRED_COUNT_INITIAL}" \
        --launch-type FARGATE \
        --platform-version LATEST \
        --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_ID}],securityGroups=[${BOT_SG}],assignPublicIp=ENABLED}" \
        --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=0" \
        --query 'service.serviceArn' --output text
fi

# --- 8. Application Auto Scaling target (min=1, max=3) ---
SCALABLE_TARGET_ID="service/${CLUSTER}/${SERVICE_NAME}"
CURRENT_TARGET=$(aws_cli application-autoscaling describe-scalable-targets \
    --service-namespace ecs --resource-ids "${SCALABLE_TARGET_ID}" \
    --query 'ScalableTargets[0].ResourceId' --output text 2>/dev/null || echo "None")

if [ "${CURRENT_TARGET}" = "None" ] || [ -z "${CURRENT_TARGET}" ]; then
    log "registering scalable target min=${AUTOSCALE_MIN} max=${AUTOSCALE_MAX}"
    aws_cli application-autoscaling register-scalable-target \
        --service-namespace ecs \
        --resource-id "${SCALABLE_TARGET_ID}" \
        --scalable-dimension ecs:service:DesiredCount \
        --min-capacity "${AUTOSCALE_MIN}" --max-capacity "${AUTOSCALE_MAX}" >/dev/null
else
    log "scalable target already registered (updating min/max if drift)"
    aws_cli application-autoscaling register-scalable-target \
        --service-namespace ecs \
        --resource-id "${SCALABLE_TARGET_ID}" \
        --scalable-dimension ecs:service:DesiredCount \
        --min-capacity "${AUTOSCALE_MIN}" --max-capacity "${AUTOSCALE_MAX}" >/dev/null
fi

# --- 9. Target-tracking scaling policy on custom metric ---
# ADR §4.3: target = total_active per task = 25. Метрика
# Kingside/SyntheticBot/synth_tasks_total_active публикуется самим bot-service
# (PutMetricData в B2v2/scheduler) с dimension ServiceName=kingside-synthetic-bot-service.
# Statistic=Average → среднее по task'ам сервиса.
POLICY_NAME="${SERVICE_NAME}-total-active-tt"
POLICY_EXISTS=$(aws_cli application-autoscaling describe-scaling-policies \
    --service-namespace ecs --resource-id "${SCALABLE_TARGET_ID}" \
    --query "ScalingPolicies[?PolicyName=='${POLICY_NAME}'] | [0].PolicyARN" --output text 2>/dev/null || echo "None")

POLICY_CFG=$(cat <<EOF
{
  "TargetValue": ${AUTOSCALE_TARGET}.0,
  "CustomizedMetricSpecification": {
    "MetricName": "${METRIC_NAME}",
    "Namespace": "${METRIC_NAMESPACE}",
    "Dimensions": [
      {"Name": "ServiceName", "Value": "${SERVICE_NAME}"}
    ],
    "Statistic": "Average",
    "Unit": "Count"
  },
  "ScaleInCooldown": 300,
  "ScaleOutCooldown": 300
}
EOF
)

if [ "${POLICY_EXISTS}" = "None" ] || [ -z "${POLICY_EXISTS}" ]; then
    log "creating target-tracking policy ${POLICY_NAME} (target=${AUTOSCALE_TARGET})"
else
    log "updating target-tracking policy ${POLICY_NAME} (target=${AUTOSCALE_TARGET})"
fi
aws_cli application-autoscaling put-scaling-policy \
    --service-namespace ecs \
    --resource-id "${SCALABLE_TARGET_ID}" \
    --scalable-dimension ecs:service:DesiredCount \
    --policy-name "${POLICY_NAME}" \
    --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration "${POLICY_CFG}" \
    --query 'PolicyARN' --output text >/dev/null

log "done. service ARN:"
aws_cli ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE_NAME}" \
    --query 'services[0].serviceArn' --output text
