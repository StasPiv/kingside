#!/usr/bin/env bash
# KS-1659: Archive extraction [D3] — bootstrap ECS-инфраструктуры archive-service.
#
# Идемпотентный скрипт. Повторные запуски безопасны: каждый шаг проверяет
# существующее состояние и пропускает уже настроенное.
#
# Что настраивает:
#   - Target group kingside-archive-api — health-check-path на /_/health (KS-1658
#     изначально прописал /health; приложение обслуживает /_/health, см. ADR-018 §2.1).
#   - Security group sg-07f96fdb66b70e8eb (kingside-ecs-sg) — ingress TCP:3003
#     от ALB SG sg-0ced47ebe5a965f68 (kingside-alb-sg).
#   - CloudWatch log group /ecs/archive-service (retention — политика AWS default,
#     PutRetentionPolicy у CI-юзера нет).
#   - ECS task definition kingside-archive-service (FARGATE, 512 CPU / 1024 MiB).
#     Контейнер: 342946498289.dkr.ecr.eu-central-1.amazonaws.com/kingside-archive-service:latest
#     Secrets из kingside/archive-service (ARCHIVE_DATABASE_URL) и kingside/api
#     (REDIS_HOST, REDIS_PORT).
#   - ECS service kingside-archive-service (cluster kingside), desired=1.
#     TG: kingside-archive-api, subnets/SG — те же, что у kingside-api.
#   - Application Auto Scaling — min=1, max=2, target-tracking ALB
#     RequestCountPerTarget=1000/min.
#
# Что НЕ делает:
#   - Docker build/push — это в scripts/deploy-aws.sh scope=archive-service.
#     Перед первым запуском этого скрипта образ `:latest` должен быть в ECR
#     (иначе таска будет CrashLoop'ить).
#   - Data migration (KS-N06) и переключение archive-importer (KS-N06/N07).
#
# Предпосылки (должны быть до запуска):
#   - KS-1657 (archive_kingside DB + secret kingside/archive-service).
#   - KS-1658 (ALB listener rule + DNS archive.kingside.site + target group).
#   - KS-1656 / KS-N02 (apps/archive-service с Dockerfile).
#   - Образ kingside-archive-service:latest в ECR (push через deploy-aws.sh).

set -euo pipefail

REGION="${REGION:-eu-central-1}"
ACCOUNT_ID="${ACCOUNT_ID:-342946498289}"
CLUSTER="${CLUSTER:-kingside}"
SERVICE_NAME="${SERVICE_NAME:-kingside-archive-service}"
TASK_FAMILY="${TASK_FAMILY:-kingside-archive-service}"
TG_ARN="${TG_ARN:-arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:targetgroup/kingside-archive-api/7ebea5c02f12cd12}"
ECS_SG="${ECS_SG:-sg-07f96fdb66b70e8eb}"
ALB_SG="${ALB_SG:-sg-0ced47ebe5a965f68}"
SUBNETS="${SUBNETS:-subnet-0fcc377586c117002,subnet-0374b32497e079707}"
ARCHIVE_SECRET_ARN="${ARCHIVE_SECRET_ARN:-arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:kingside/archive-service-2fsprR}"
API_SECRET_ARN="${API_SECRET_ARN:-arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:kingside/api-nfkTKX}"
LOG_GROUP="${LOG_GROUP:-/ecs/archive-service}"
ECR_IMAGE="${ECR_IMAGE:-${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-archive-service:latest}"
CORS_ORIGIN="${CORS_ORIGIN:-https://kingside.site,https://www.kingside.site}"
CONTAINER_PORT="${CONTAINER_PORT:-3003}"

aws_cli() { aws --region "${REGION}" "$@"; }
log() { printf '[archive-service-setup] %s\n' "$*"; }

# --- 1. Target group health-check-path ---
CURRENT_HC_PATH=$(aws_cli elbv2 describe-target-groups --target-group-arns "${TG_ARN}" \
    --query 'TargetGroups[0].HealthCheckPath' --output text)
if [ "${CURRENT_HC_PATH}" != "/_/health" ]; then
    log "updating target group health-check-path ${CURRENT_HC_PATH} → /_/health"
    aws_cli elbv2 modify-target-group --target-group-arn "${TG_ARN}" \
        --health-check-path /_/health >/dev/null
else
    log "target group health-check-path already /_/health"
fi

# --- 2. Security group ingress 3003 ---
# AWS возвращает IpPermissions в необычной форме (вложенные массивы), из-за чего
# JMESPath-фильтр не всегда находит совпадение. Поэтому просто пробуем добавить
# правило и игнорируем InvalidPermission.Duplicate.
set +e
SG_OUT=$(aws_cli ec2 authorize-security-group-ingress \
    --group-id "${ECS_SG}" \
    --ip-permissions "IpProtocol=tcp,FromPort=${CONTAINER_PORT},ToPort=${CONTAINER_PORT},UserIdGroupPairs=[{GroupId=${ALB_SG},Description=\"archive-service ALB ingress\"}]" \
    2>&1)
SG_RC=$?
set -e
if [ ${SG_RC} -eq 0 ]; then
    log "added ingress TCP:${CONTAINER_PORT} from ${ALB_SG} → ${ECS_SG}"
elif echo "${SG_OUT}" | grep -q "InvalidPermission.Duplicate"; then
    log "SG ingress TCP:${CONTAINER_PORT} from ${ALB_SG} already present"
else
    echo "${SG_OUT}" >&2
    exit ${SG_RC}
fi

# --- 3. CloudWatch log group ---
LG_EXISTS=$(aws_cli logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" \
    --query "logGroups[?logGroupName=='${LOG_GROUP}'] | [0].logGroupName" --output text)
if [ -z "${LG_EXISTS}" ] || [ "${LG_EXISTS}" = "None" ]; then
    log "creating log group ${LOG_GROUP}"
    aws_cli logs create-log-group --log-group-name "${LOG_GROUP}"
else
    log "log group ${LOG_GROUP} exists"
fi

# --- 4. ECS Task definition ---
TASKDEF_JSON=$(cat <<EOF
{
  "family": "${TASK_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskRole",
  "containerDefinitions": [
    {
      "name": "${TASK_FAMILY}",
      "image": "${ECR_IMAGE}",
      "essential": true,
      "portMappings": [
        {"containerPort": ${CONTAINER_PORT}, "hostPort": ${CONTAINER_PORT}, "protocol": "tcp"}
      ],
      "environment": [
        {"name": "NODE_ENV", "value": "production"},
        {"name": "ARCHIVE_SERVICE_PORT", "value": "${CONTAINER_PORT}"},
        {"name": "PORT", "value": "${CONTAINER_PORT}"},
        {"name": "ARCHIVE_STATS_IMPL", "value": "postgres"},
        {"name": "CORS_ORIGIN", "value": "${CORS_ORIGIN}"}
      ],
      "secrets": [
        {"name": "ARCHIVE_DATABASE_URL", "valueFrom": "${ARCHIVE_SECRET_ARN}:ARCHIVE_DATABASE_URL::"},
        {"name": "REDIS_HOST",           "valueFrom": "${API_SECRET_ARN}:REDIS_HOST::"},
        {"name": "REDIS_PORT",           "valueFrom": "${API_SECRET_ARN}:REDIS_PORT::"}
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
        "command": ["CMD-SHELL", "node -e \"const h=require('http');h.get('http://localhost:${CONTAINER_PORT}/_/health',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))\""],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 40
      }
    }
  ]
}
EOF
)
TASKDEF_FILE="$(mktemp -t archive-taskdef.XXXXXX.json)"
trap 'rm -f "${TASKDEF_FILE}"' EXIT
printf '%s' "${TASKDEF_JSON}" > "${TASKDEF_FILE}"
TD_ARN=$(aws_cli ecs register-task-definition --cli-input-json "file://${TASKDEF_FILE}" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
log "registered task definition: ${TD_ARN}"

# --- 5. ECS service ---
SVC_STATUS=$(aws_cli ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE_NAME}" \
    --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")

if [ "${SVC_STATUS}" = "ACTIVE" ]; then
    log "service ${SERVICE_NAME} exists → update-service --task-definition ${TD_ARN}"
    aws_cli ecs update-service --cluster "${CLUSTER}" --service "${SERVICE_NAME}" \
        --task-definition "${TD_ARN}" --force-new-deployment \
        --query 'service.deployments[0].status' --output text
else
    log "creating service ${SERVICE_NAME}"
    aws_cli ecs create-service \
        --cluster "${CLUSTER}" \
        --service-name "${SERVICE_NAME}" \
        --task-definition "${TD_ARN}" \
        --desired-count 1 \
        --launch-type FARGATE \
        --platform-version LATEST \
        --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${ECS_SG}],assignPublicIp=ENABLED}" \
        --load-balancers "targetGroupArn=${TG_ARN},containerName=${TASK_FAMILY},containerPort=${CONTAINER_PORT}" \
        --health-check-grace-period-seconds 60 \
        --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" \
        --query 'service.serviceArn' --output text
fi

# --- 6. Application Auto Scaling ---
SCALABLE_TARGET_ID="service/${CLUSTER}/${SERVICE_NAME}"
CURRENT_TARGET=$(aws_cli application-autoscaling describe-scalable-targets \
    --service-namespace ecs --resource-ids "${SCALABLE_TARGET_ID}" \
    --query 'ScalableTargets[0].ResourceId' --output text 2>/dev/null || echo "None")

if [ "${CURRENT_TARGET}" = "None" ] || [ -z "${CURRENT_TARGET}" ]; then
    log "registering scalable target min=1 max=2"
    aws_cli application-autoscaling register-scalable-target \
        --service-namespace ecs \
        --resource-id "${SCALABLE_TARGET_ID}" \
        --scalable-dimension ecs:service:DesiredCount \
        --min-capacity 1 --max-capacity 2 >/dev/null
else
    log "scalable target already registered"
fi

# Target-tracking: ALB RequestCountPerTarget ~1000 за минуту
TG_SUFFIX="$(echo "${TG_ARN}" | sed 's|.*:targetgroup/||')"
ALB_ARN="$(aws_cli elbv2 describe-target-groups --target-group-arns "${TG_ARN}" \
    --query 'TargetGroups[0].LoadBalancerArns[0]' --output text)"
ALB_SUFFIX="$(echo "${ALB_ARN}" | sed 's|.*:loadbalancer/||')"
# Формат ResourceLabel для ALBRequestCountPerTarget:
#   app/<alb-name>/<alb-id>/targetgroup/<tg-name>/<tg-id>
RESOURCE_LABEL="${ALB_SUFFIX}/targetgroup/${TG_SUFFIX}"

POLICY_EXISTS=$(aws_cli application-autoscaling describe-scaling-policies \
    --service-namespace ecs --resource-id "${SCALABLE_TARGET_ID}" \
    --query "ScalingPolicies[?PolicyName=='${SERVICE_NAME}-alb-rps'] | [0].PolicyARN" --output text 2>/dev/null || echo "None")

if [ "${POLICY_EXISTS}" = "None" ] || [ -z "${POLICY_EXISTS}" ]; then
    log "creating target-tracking scaling policy (ALB RequestCountPerTarget=1000/min)"
    POLICY_CFG=$(cat <<EOF
{
  "TargetValue": 1000.0,
  "PredefinedMetricSpecification": {
    "PredefinedMetricType": "ALBRequestCountPerTarget",
    "ResourceLabel": "${RESOURCE_LABEL}"
  },
  "ScaleInCooldown": 120,
  "ScaleOutCooldown": 60
}
EOF
)
    aws_cli application-autoscaling put-scaling-policy \
        --service-namespace ecs \
        --resource-id "${SCALABLE_TARGET_ID}" \
        --scalable-dimension ecs:service:DesiredCount \
        --policy-name "${SERVICE_NAME}-alb-rps" \
        --policy-type TargetTrackingScaling \
        --target-tracking-scaling-policy-configuration "${POLICY_CFG}" >/dev/null
else
    log "scaling policy already present: ${POLICY_EXISTS}"
fi

log "done. service ARN:"
aws_cli ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE_NAME}" \
    --query 'services[0].serviceArn' --output text
