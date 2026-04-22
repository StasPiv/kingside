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

# =============================================================================
# KS-1682 / ADR-020: archive-importer oneshot (EventBridge Scheduler + daily RunTask).
# Отдельный importer крутился постоянным service'ом (task-def kingside-archive-importer:v1..v6)
# и раз в сутки через внутренний cron запускал import. После ADR-020 переводим его
# на EventBridge Scheduler + разовый ECS RunTask (cron(0 20 ? * * *) UTC).
# Блок идемпотентный: повторные запуски безопасны.
# =============================================================================

IMPORTER_FAMILY="kingside-archive-importer-oneshot"
IMPORTER_LOG_GROUP="/kingside/archive-importer-oneshot"
IMPORTER_ECS_EVENTS_LOG_GROUP="/kingside/archive-importer-ecs-events"
IMPORTER_DLQ_NAME="kingside-archive-importer-dlq"
IMPORTER_DLQ_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${IMPORTER_DLQ_NAME}"
IMPORTER_SCHED_ROLE_NAME="kingside-archive-importer-scheduler-role"
IMPORTER_SCHED_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${IMPORTER_SCHED_ROLE_NAME}"
IMPORTER_SCHED_NAME="kingside-archive-importer-daily"
IMPORTER_EVENT_RULE_NAME="kingside-archive-importer-ecs-task-state-change"
IMPORTER_ALERT_SNS_ARN="${IMPORTER_ALERT_SNS_ARN:-arn:aws:sns:${REGION}:${ACCOUNT_ID}:kingside-alerts}"
IMPORTER_METRIC_NAMESPACE="Kingside/ArchiveImporter"

# --- 7. Log groups для oneshot-importer ---
for LG in "${IMPORTER_LOG_GROUP}" "${IMPORTER_ECS_EVENTS_LOG_GROUP}"; do
    LG_EXISTS=$(aws_cli logs describe-log-groups --log-group-name-prefix "${LG}" \
        --query "logGroups[?logGroupName=='${LG}'] | [0].logGroupName" --output text)
    if [ -z "${LG_EXISTS}" ] || [ "${LG_EXISTS}" = "None" ]; then
        log "creating log group ${LG}"
        aws_cli logs create-log-group --log-group-name "${LG}"
    else
        log "log group ${LG} exists"
    fi
done
# Retention: 90 дней для oneshot, 30 для ecs-events.
# ВАЖНО: logs:PutRetentionPolicy не входит в базовый AWS managed-policy для CI-user.
# В kingside-ci требуется inline policy с этим action (см. archive-importer-setup).
aws_cli logs put-retention-policy --log-group-name "${IMPORTER_LOG_GROUP}" --retention-in-days 90 || \
    log "WARN: PutRetentionPolicy на ${IMPORTER_LOG_GROUP} не удалось — проверь права kingside-ci"
aws_cli logs put-retention-policy --log-group-name "${IMPORTER_ECS_EVENTS_LOG_GROUP}" --retention-in-days 30 || \
    log "WARN: PutRetentionPolicy на ${IMPORTER_ECS_EVENTS_LOG_GROUP} не удалось"

# --- 8. DLQ для EventBridge Scheduler ---
set +e
DLQ_URL=$(aws_cli sqs get-queue-url --queue-name "${IMPORTER_DLQ_NAME}" --query 'QueueUrl' --output text 2>/dev/null)
DLQ_RC=$?
set -e
if [ ${DLQ_RC} -ne 0 ] || [ -z "${DLQ_URL}" ] || [ "${DLQ_URL}" = "None" ]; then
    log "creating SQS DLQ ${IMPORTER_DLQ_NAME}"
    aws_cli sqs create-queue --queue-name "${IMPORTER_DLQ_NAME}" \
        --attributes "MessageRetentionPeriod=1209600" \
        --query 'QueueUrl' --output text
else
    log "DLQ ${IMPORTER_DLQ_NAME} exists: ${DLQ_URL}"
fi

# --- 9. IAM role для EventBridge Scheduler → ECS RunTask ---
set +e
ROLE_CHECK=$(aws_cli iam get-role --role-name "${IMPORTER_SCHED_ROLE_NAME}" --query 'Role.Arn' --output text 2>/dev/null)
ROLE_RC=$?
set -e
if [ ${ROLE_RC} -ne 0 ] || [ -z "${ROLE_CHECK}" ] || [ "${ROLE_CHECK}" = "None" ]; then
    log "creating IAM role ${IMPORTER_SCHED_ROLE_NAME}"
    TRUST_FILE="$(mktemp -t scheduler-trust.XXXXXX.json)"
    cat > "${TRUST_FILE}" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "scheduler.amazonaws.com"},
    "Action": "sts:AssumeRole",
    "Condition": {"StringEquals": {"aws:SourceAccount": "${ACCOUNT_ID}"}}
  }]
}
EOF
    aws_cli iam create-role --role-name "${IMPORTER_SCHED_ROLE_NAME}" \
        --assume-role-policy-document "file://${TRUST_FILE}" \
        --description "EventBridge Scheduler role for kingside-archive-importer daily RunTask (KS-1682)" \
        --query 'Role.Arn' --output text
    rm -f "${TRUST_FILE}"
else
    log "IAM role ${IMPORTER_SCHED_ROLE_NAME} exists: ${ROLE_CHECK}"
fi

# Inline least-privilege policy (всегда перезаписываем — idempotent).
POLICY_FILE="$(mktemp -t scheduler-policy.XXXXXX.json)"
cat > "${POLICY_FILE}" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECSRunTask",
      "Effect": "Allow",
      "Action": "ecs:RunTask",
      "Resource": "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${IMPORTER_FAMILY}:*"
    },
    {
      "Sid": "IAMPassRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole",
        "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskRole"
      ]
    },
    {
      "Sid": "SQSDlq",
      "Effect": "Allow",
      "Action": "sqs:SendMessage",
      "Resource": "${IMPORTER_DLQ_ARN}"
    }
  ]
}
EOF
aws_cli iam put-role-policy --role-name "${IMPORTER_SCHED_ROLE_NAME}" \
    --policy-name scheduler-runtask \
    --policy-document "file://${POLICY_FILE}"
rm -f "${POLICY_FILE}"
log "IAM role policy scheduler-runtask attached"

# --- 10. Task definition oneshot ---
IMPORTER_TD_JSON=$(cat <<EOF
{
  "family": "${IMPORTER_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskRole",
  "containerDefinitions": [
    {
      "name": "${IMPORTER_FAMILY}",
      "image": "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-archive-service:latest",
      "essential": true,
      "command": ["node", "dist/importer-once.js"],
      "environment": [
        {"name": "NODE_ENV", "value": "production"},
        {"name": "AWS_EMF_ENVIRONMENT", "value": "Local"},
        {"name": "AWS_EMF_NAMESPACE", "value": "${IMPORTER_METRIC_NAMESPACE}"},
        {"name": "AWS_EMF_LOG_GROUP_NAME", "value": "${IMPORTER_LOG_GROUP}"}
      ],
      "secrets": [
        {"name": "ARCHIVE_DATABASE_URL", "valueFrom": "${ARCHIVE_SECRET_ARN}:ARCHIVE_DATABASE_URL::"},
        {"name": "REDIS_URL",  "valueFrom": "${API_SECRET_ARN}:REDIS_URL::"},
        {"name": "REDIS_HOST", "valueFrom": "${API_SECRET_ARN}:REDIS_HOST::"},
        {"name": "REDIS_PORT", "valueFrom": "${API_SECRET_ARN}:REDIS_PORT::"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${IMPORTER_LOG_GROUP}",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
EOF
)
# AWS_EMF_ENVIRONMENT=Local — заставляет aws-embedded-metrics писать EMF-JSON
# в stdout вместо попытки отправить через CloudWatch agent sidecar; в ECS Fargate
# EMF-строки подхватывает awslogs-driver и CloudWatch Logs автоматически парсит
# их в метрики. ADR-020 §2.1 + §2.5 (вариант B). KS-1714.
IMPORTER_TD_FILE="$(mktemp -t importer-taskdef.XXXXXX.json)"
printf '%s' "${IMPORTER_TD_JSON}" > "${IMPORTER_TD_FILE}"
IMPORTER_TD_ARN=$(aws_cli ecs register-task-definition --cli-input-json "file://${IMPORTER_TD_FILE}" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
rm -f "${IMPORTER_TD_FILE}"
log "registered oneshot task-def: ${IMPORTER_TD_ARN}"
# ARN ревизии (вида ...:task-definition/kingside-archive-importer-oneshot:N) —
# ниже используется для pin'а в EventBridge Scheduler target (avoid drift).

# --- 11. EventBridge Scheduler (cron 0 20 ? * * * UTC, ENABLED) ---
IMPORTER_SCHED_JSON=$(cat <<EOF
{
  "Name": "${IMPORTER_SCHED_NAME}",
  "ScheduleExpression": "cron(0 20 ? * * *)",
  "ScheduleExpressionTimezone": "UTC",
  "State": "ENABLED",
  "FlexibleTimeWindow": {"Mode": "OFF"},
  "Description": "Daily archive-importer oneshot run at 20:00 UTC (ADR-020, KS-1682)",
  "Target": {
    "Arn": "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER}",
    "RoleArn": "${IMPORTER_SCHED_ROLE_ARN}",
    "EcsParameters": {
      "TaskDefinitionArn": "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${IMPORTER_FAMILY}",
      "LaunchType": "FARGATE",
      "PlatformVersion": "LATEST",
      "NetworkConfiguration": {
        "awsvpcConfiguration": {
          "Subnets": ["${SUBNETS/,/\",\"}"],
          "SecurityGroups": ["${ECS_SG}"],
          "AssignPublicIp": "ENABLED"
        }
      },
      "TaskCount": 1
    },
    "RetryPolicy": {
      "MaximumRetryAttempts": 2,
      "MaximumEventAgeInSeconds": 3600
    },
    "DeadLetterConfig": {
      "Arn": "${IMPORTER_DLQ_ARN}"
    }
  }
}
EOF
)
IMPORTER_SCHED_FILE="$(mktemp -t importer-sched.XXXXXX.json)"
printf '%s' "${IMPORTER_SCHED_JSON}" > "${IMPORTER_SCHED_FILE}"
set +e
aws_cli scheduler get-schedule --name "${IMPORTER_SCHED_NAME}" --query 'Arn' --output text >/dev/null 2>&1
SCHED_RC=$?
set -e
if [ ${SCHED_RC} -eq 0 ]; then
    log "updating scheduler ${IMPORTER_SCHED_NAME}"
    aws_cli scheduler update-schedule --cli-input-json "file://${IMPORTER_SCHED_FILE}" >/dev/null
else
    log "creating scheduler ${IMPORTER_SCHED_NAME}"
    aws_cli scheduler create-schedule --cli-input-json "file://${IMPORTER_SCHED_FILE}" \
        --query 'ScheduleArn' --output text
fi
rm -f "${IMPORTER_SCHED_FILE}"

# --- 12. EventBridge rule: ECS Task State Change → CW Log group ---
IMPORTER_EVENT_PATTERN=$(cat <<EOF
{
  "source": ["aws.ecs"],
  "detail-type": ["ECS Task State Change"],
  "detail": {
    "clusterArn": ["arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER}"],
    "lastStatus": ["STOPPED"],
    "taskDefinitionArn": [{"prefix": "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${IMPORTER_FAMILY}"}]
  }
}
EOF
)
IMPORTER_EVENT_FILE="$(mktemp -t event-pattern.XXXXXX.json)"
printf '%s' "${IMPORTER_EVENT_PATTERN}" > "${IMPORTER_EVENT_FILE}"
aws_cli events put-rule --name "${IMPORTER_EVENT_RULE_NAME}" \
    --event-pattern "file://${IMPORTER_EVENT_FILE}" \
    --state ENABLED \
    --description "ECS Task State Change events for archive-importer oneshot (KS-1682)" >/dev/null
rm -f "${IMPORTER_EVENT_FILE}"

IMPORTER_EVENTS_LOG_ARN="arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${IMPORTER_ECS_EVENTS_LOG_GROUP}"
aws_cli events put-targets --rule "${IMPORTER_EVENT_RULE_NAME}" \
    --targets "Id=1,Arn=${IMPORTER_EVENTS_LOG_ARN}" >/dev/null
log "EventBridge rule ${IMPORTER_EVENT_RULE_NAME} configured"

# EventBridge → CloudWatch Logs требует resource-based policy на log group.
# Console добавляет её автоматически, CLI — нет. Без этой policy events silently
# не доставляются (no error, target метки стоят — но log stream не появляется).
IMPORTER_LOGS_RESOURCE_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "EventBridgeToCWLogs",
    "Effect": "Allow",
    "Principal": {"Service": ["events.amazonaws.com", "delivery.logs.amazonaws.com"]},
    "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
    "Resource": ["arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${IMPORTER_ECS_EVENTS_LOG_GROUP}:*"],
    "Condition": {
      "StringEquals": {"aws:SourceAccount": "${ACCOUNT_ID}"},
      "ArnLike": {"aws:SourceArn": "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/*"}
    }
  }]
}
EOF
)
IMPORTER_LRP_FILE="$(mktemp -t logs-resource-policy.XXXXXX.json)"
printf '%s' "${IMPORTER_LOGS_RESOURCE_POLICY}" > "${IMPORTER_LRP_FILE}"
aws_cli logs put-resource-policy --policy-name ArchiveImporterEventsToLogs \
    --policy-document "file://${IMPORTER_LRP_FILE}" >/dev/null
rm -f "${IMPORTER_LRP_FILE}"
log "logs resource policy ArchiveImporterEventsToLogs attached"

# --- 13. CloudWatch metric filter на exit != 0 ---
aws_cli logs put-metric-filter \
    --log-group-name "${IMPORTER_ECS_EVENTS_LOG_GROUP}" \
    --filter-name "archive-importer-ecs-exit-nonzero" \
    --filter-pattern '{ $.detail.containers[0].exitCode != 0 }' \
    --metric-transformations "metricName=ECSExitNonZero,metricNamespace=${IMPORTER_METRIC_NAMESPACE},metricValue=1,defaultValue=0"
log "metric filter ECSExitNonZero configured"

# --- 14. 5 CloudWatch Alarms → SNS kingside-alerts (ADR-020 §2.7) ---
# 14.1 DLQ depth > 0 за 1 минуту
aws_cli cloudwatch put-metric-alarm \
    --alarm-name "archive-importer-dlq-depth" \
    --alarm-description "KS-1682: archive-importer DLQ has messages (EventBridge retry failures)" \
    --metric-name ApproximateNumberOfMessagesVisible \
    --namespace AWS/SQS \
    --statistic Maximum \
    --dimensions "Name=QueueName,Value=${IMPORTER_DLQ_NAME}" \
    --period 60 --evaluation-periods 1 --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "${IMPORTER_ALERT_SNS_ARN}" \
    --ok-actions "${IMPORTER_ALERT_SNS_ARN}"

# 14.2 ECS exit != 0
aws_cli cloudwatch put-metric-alarm \
    --alarm-name "archive-importer-ecs-exit-nonzero" \
    --alarm-description "KS-1682: archive-importer oneshot task exited with non-zero code" \
    --metric-name ECSExitNonZero \
    --namespace "${IMPORTER_METRIC_NAMESPACE}" \
    --statistic Sum \
    --period 300 --evaluation-periods 1 --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "${IMPORTER_ALERT_SNS_ARN}" \
    --ok-actions "${IMPORTER_ALERT_SNS_ARN}"

# 14.3 EMF SourcesFailed > 0 за 1 час
aws_cli cloudwatch put-metric-alarm \
    --alarm-name "archive-importer-sources-failed" \
    --alarm-description "KS-1682: archive-importer reported SourcesFailed > 0 (EMF)" \
    --metric-name SourcesFailed \
    --namespace "${IMPORTER_METRIC_NAMESPACE}" \
    --statistic Sum \
    --period 3600 --evaluation-periods 1 --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "${IMPORTER_ALERT_SNS_ARN}" \
    --ok-actions "${IMPORTER_ALERT_SNS_ARN}"

# 14.4 EMF LastSuccessAgeSeconds > 14 дней (1209600), 2×1h, breaching.
# Backend публикует LastSuccessAgeSeconds per source (dimension source=<code>).
# На момент KS-1682 единственный активный source — twic; добавлять новые алармы
# при появлении новых источников (lichess-elite/ccrl/…) — отдельной задачей.
aws_cli cloudwatch put-metric-alarm \
    --alarm-name "archive-importer-last-success-age" \
    --alarm-description "KS-1682: LastSuccessAgeSeconds > 14 days (archive-importer stalled) for source=twic" \
    --metric-name LastSuccessAgeSeconds \
    --namespace "${IMPORTER_METRIC_NAMESPACE}" \
    --dimensions "Name=source,Value=twic" \
    --statistic Maximum \
    --period 3600 --evaluation-periods 2 --threshold 1209600 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data breaching \
    --alarm-actions "${IMPORTER_ALERT_SNS_ARN}" \
    --ok-actions "${IMPORTER_ALERT_SNS_ARN}"

# 14.5 Scheduler invocations = 0 за 24 часа
aws_cli cloudwatch put-metric-alarm \
    --alarm-name "archive-importer-scheduler-no-invocations" \
    --alarm-description "KS-1682: EventBridge Scheduler did not invoke archive-importer in 24h" \
    --metric-name InvocationAttemptCount \
    --namespace AWS/Scheduler \
    --statistic Sum \
    --dimensions "Name=ScheduleGroup,Value=default" "Name=ScheduleName,Value=${IMPORTER_SCHED_NAME}" \
    --period 86400 --evaluation-periods 1 --threshold 1 \
    --comparison-operator LessThanThreshold \
    --treat-missing-data breaching \
    --alarm-actions "${IMPORTER_ALERT_SNS_ARN}" \
    --ok-actions "${IMPORTER_ALERT_SNS_ARN}"

log "archive-importer oneshot infrastructure ready. Schedule: ${IMPORTER_SCHED_NAME}."
log "NOTE: старый service kingside-archive-importer удаляется отдельно после первого"
log "      успешного RunTask — см. шаг 7 из KS-1682 (aws ecs delete-service)."

# =============================================================================
# KS-1684 / ADR-020 §2.4: archive-importer ad-hoc (ручной backward-walk TWIC).
# Отдельный task-def + log group под ретроспективный CLI
# `apps/archive-service/src/cli/import-twic-issue.ts` (сейчас TWIC-1639, далее
# 1638/1637/…). Не имеет EventBridge Scheduler'а — запуск руками через
# `aws ecs run-task --overrides 'containerOverrides=[{name=...,command=[...,<issue>]}]'`.
#
# Почему отдельный task-def (а не --overrides на oneshot):
#   - ретроспективный backward-walk при регулярном использовании зашумит log
#     group daily scheduler'а;
#   - IaC должен отражать все сущности явно (ADR-020 §2.4.1);
#   - в env НЕ выставляем AWS_EMF_* (если бы ad-hoc шёл в oneshot family, при
#     будущем добавлении EMF-env в oneshot случайно опубликовали бы метрики из
#     ручного backfill) — ADR-020 §2.4.2.
# Блок идемпотентный.
# =============================================================================

ADHOC_FAMILY="kingside-archive-importer-adhoc"
ADHOC_LOG_GROUP="/kingside/archive-importer-adhoc"

# --- 15. Log group для ad-hoc importer'а ---
LG_EXISTS=$(aws_cli logs describe-log-groups --log-group-name-prefix "${ADHOC_LOG_GROUP}" \
    --query "logGroups[?logGroupName=='${ADHOC_LOG_GROUP}'] | [0].logGroupName" --output text)
if [ -z "${LG_EXISTS}" ] || [ "${LG_EXISTS}" = "None" ]; then
    log "creating log group ${ADHOC_LOG_GROUP}"
    aws_cli logs create-log-group --log-group-name "${ADHOC_LOG_GROUP}"
else
    log "log group ${ADHOC_LOG_GROUP} exists"
fi
# Retention 30 дней — ad-hoc редкий (несколько запусков в год на backward-walk),
# 30d достаточно для постмортема, больше — необоснованный cost.
aws_cli logs put-retention-policy --log-group-name "${ADHOC_LOG_GROUP}" --retention-in-days 30 || \
    log "WARN: PutRetentionPolicy на ${ADHOC_LOG_GROUP} не удалось — проверь права kingside-ci"

# --- 16. Task definition ad-hoc ---
# command: заглушка ["node", "dist/cli/import-twic-issue.js"] — реальный аргумент
# (номер выпуска) передаётся через --overrides.containerOverrides.command[2].
# Environment НЕ содержит AWS_EMF_NAMESPACE / AWS_EMF_LOG_GROUP_NAME (ADR-020 §2.4.2):
# CLI не должен публиковать EMF из ручных backfill-запусков.
ADHOC_TD_JSON=$(cat <<EOF
{
  "family": "${ADHOC_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskRole",
  "containerDefinitions": [
    {
      "name": "${ADHOC_FAMILY}",
      "image": "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-archive-service:latest",
      "essential": true,
      "command": ["node", "dist/cli/import-twic-issue.js"],
      "environment": [
        {"name": "NODE_ENV", "value": "production"}
      ],
      "secrets": [
        {"name": "ARCHIVE_DATABASE_URL", "valueFrom": "${ARCHIVE_SECRET_ARN}:ARCHIVE_DATABASE_URL::"},
        {"name": "REDIS_URL",  "valueFrom": "${API_SECRET_ARN}:REDIS_URL::"},
        {"name": "REDIS_HOST", "valueFrom": "${API_SECRET_ARN}:REDIS_HOST::"},
        {"name": "REDIS_PORT", "valueFrom": "${API_SECRET_ARN}:REDIS_PORT::"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${ADHOC_LOG_GROUP}",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "adhoc"
        }
      }
    }
  ]
}
EOF
)
ADHOC_TD_FILE="$(mktemp -t adhoc-taskdef.XXXXXX.json)"
printf '%s' "${ADHOC_TD_JSON}" > "${ADHOC_TD_FILE}"
ADHOC_TD_ARN=$(aws_cli ecs register-task-definition --cli-input-json "file://${ADHOC_TD_FILE}" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
rm -f "${ADHOC_TD_FILE}"
log "registered ad-hoc task-def: ${ADHOC_TD_ARN}"

log "archive-importer ad-hoc infrastructure ready. Run-task example:"
log "  aws ecs run-task --cluster ${CLUSTER} --task-definition ${ADHOC_FAMILY} \\"
log "    --launch-type FARGATE --network-configuration \\"
log "    \"awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${ECS_SG}],assignPublicIp=ENABLED}\" \\"
log "    --overrides 'containerOverrides=[{name=${ADHOC_FAMILY},command=[\"node\",\"dist/cli/import-twic-issue.js\",\"<ISSUE_NUMBER>\"]}]'"
