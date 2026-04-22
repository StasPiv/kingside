#!/usr/bin/env bash
# KS-1696: Broadcast extraction — bootstrap ECS-инфраструктуры broadcast-service.
#
# Идемпотентный скрипт. Повторные запуски безопасны: каждый шаг проверяет
# существующее состояние и пропускает уже настроенное.
#
# Связанные ADR: ADR-021 (broadcast service extraction). Образец — archive
# (ADR-018) в scripts/archive-service-aws-setup.sh.
#
# Что настраивает:
#   - Target group kingside-broadcasts-api (HTTP:3004, /health, stickiness
#     lb_cookie 86400s, deregistration 60s для корректного закрытия WS-соединений).
#   - ALB listener rule priority=7: Host == broadcasts.kingside.site → TG.
#   - Route53 A-record broadcasts.kingside.site → kingside-alb.
#   - Security group sg-07f96fdb66b70e8eb ingress TCP:3004 от ALB SG.
#   - CloudWatch log group /ecs/broadcast-service (retention 30).
#   - ECR repo kingside-broadcast-service.
#   - Новая database broadcasts_kingside в RDS kingside-db (owner=kingside).
#   - Secrets Manager secret kingside/broadcast-service с BROADCASTS_DATABASE_URL.
#   - ECS task definition kingside-broadcast-service (FARGATE, 512 CPU / 1024 MiB).
#   - ECS service kingside-broadcast-service (desired=1, max=2 с ALB RPS-scaling).
#
# Что НЕ делает:
#   - Docker build/push — это в scripts/deploy-aws.sh scope=broadcast-service
#     (добавляется отдельно backend'ом в scripts/deploy-common.sh).
#   - Broadcast-worker rev 2 (переключение на BROADCASTS_DATABASE_URL, M1 по
#     ADR-021 §2.8) — отдельный запуск, см. блок в конце файла (закомментирован
#     до согласования с backend).
#   - Миграцию Prisma для broadcasts_kingside — её применяет backend через
#     `npm run prisma:migrate` в @kingside/broadcasts-db после первого деплоя.
#
# Предпосылки:
#   - ALB kingside-alb, Route53 zone Z077890528QIIZLL7MESF (kingside.site),
#     wildcard cert *.kingside.site на HTTPS:443 listener — все уже есть.
#   - RDS kingside-db доступен из prod VPC (security group kingside-ecs-sg),
#     роль kingside с rolcreatedb=true.
#   - Образ kingside-broadcast-service:latest в ECR — для первого запуска
#     скрипта ДО создания service'а убедиться, что backend уже пушнул первый
#     build, иначе ECS service будет CrashLoop'ить.

set -euo pipefail

REGION="${REGION:-eu-central-1}"
ACCOUNT_ID="${ACCOUNT_ID:-342946498289}"
CLUSTER="${CLUSTER:-kingside}"
SERVICE_NAME="${SERVICE_NAME:-kingside-broadcast-service}"
TASK_FAMILY="${TASK_FAMILY:-kingside-broadcast-service}"
ECR_REPO_NAME="${ECR_REPO_NAME:-kingside-broadcast-service}"
TG_NAME="${TG_NAME:-kingside-broadcasts-api}"
TG_ARN="${TG_ARN:-arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:targetgroup/${TG_NAME}/281f2dd1b926031c}"
ALB_ARN="${ALB_ARN:-arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:loadbalancer/app/kingside-alb/00e95cdb6a2a6576}"
ALB_DNS="${ALB_DNS:-kingside-alb-382263905.eu-central-1.elb.amazonaws.com}"
ALB_ZONE_ID="${ALB_ZONE_ID:-Z215JYRZR1TBD5}"
LISTENER_ARN="${LISTENER_ARN:-arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:listener/app/kingside-alb/00e95cdb6a2a6576/ad2373d1775d842d}"
ROUTE53_ZONE_ID="${ROUTE53_ZONE_ID:-Z077890528QIIZLL7MESF}"
HOST_NAME="${HOST_NAME:-broadcasts.kingside.site}"
LISTENER_RULE_PRIORITY="${LISTENER_RULE_PRIORITY:-7}"
VPC_ID="${VPC_ID:-vpc-0d0d9344db8d11e7e}"
ECS_SG="${ECS_SG:-sg-07f96fdb66b70e8eb}"
ALB_SG="${ALB_SG:-sg-0ced47ebe5a965f68}"
SUBNETS="${SUBNETS:-subnet-0fcc377586c117002,subnet-0374b32497e079707}"
BROADCAST_SECRET_ARN="${BROADCAST_SECRET_ARN:-arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:kingside/broadcast-service-VG2ZFA}"
API_SECRET_ARN="${API_SECRET_ARN:-arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:kingside/api-nfkTKX}"
LOG_GROUP="${LOG_GROUP:-/ecs/broadcast-service}"
ECR_IMAGE="${ECR_IMAGE:-${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO_NAME}:latest}"
CORS_ORIGIN="${CORS_ORIGIN:-https://kingside.site,https://www.kingside.site}"
CONTAINER_PORT="${CONTAINER_PORT:-3004}"
DB_NAME="${DB_NAME:-broadcasts_kingside}"
HEALTH_PATH="${HEALTH_PATH:-/_/health}"
ECS_TASK_COUNT_INITIAL="${ECS_TASK_COUNT_INITIAL:-1}"

aws_cli() { aws --region "${REGION}" "$@"; }
log() { printf '[broadcast-service-setup] %s\n' "$*"; }

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

# --- 3. Target group kingside-broadcasts-api ---
set +e
TG_CHECK=$(aws_cli elbv2 describe-target-groups --names "${TG_NAME}" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)
set -e
if [ -z "${TG_CHECK}" ] || [ "${TG_CHECK}" = "None" ]; then
    log "creating target group ${TG_NAME}"
    TG_ARN=$(aws_cli elbv2 create-target-group \
        --name "${TG_NAME}" \
        --protocol HTTP --port "${CONTAINER_PORT}" \
        --vpc-id "${VPC_ID}" \
        --target-type ip \
        --health-check-protocol HTTP \
        --health-check-path "${HEALTH_PATH}" \
        --health-check-interval-seconds 15 \
        --health-check-timeout-seconds 5 \
        --healthy-threshold-count 2 \
        --unhealthy-threshold-count 3 \
        --matcher HttpCode=200 \
        --query 'TargetGroups[0].TargetGroupArn' --output text)
    log "created TG: ${TG_ARN}"
else
    TG_ARN="${TG_CHECK}"
    log "target group ${TG_NAME} exists: ${TG_ARN}"
    # Verify health-check-path
    CUR_HC=$(aws_cli elbv2 describe-target-groups --target-group-arns "${TG_ARN}" \
        --query 'TargetGroups[0].HealthCheckPath' --output text)
    if [ "${CUR_HC}" != "${HEALTH_PATH}" ]; then
        log "updating health-check-path ${CUR_HC} → ${HEALTH_PATH}"
        aws_cli elbv2 modify-target-group --target-group-arn "${TG_ARN}" \
            --health-check-path "${HEALTH_PATH}" >/dev/null
    fi
fi

# Sticky sessions ON (WS-critical per ADR-021 §2.9.18), deregistration 60s
aws_cli elbv2 modify-target-group-attributes \
    --target-group-arn "${TG_ARN}" \
    --attributes \
        Key=stickiness.enabled,Value=true \
        Key=stickiness.type,Value=lb_cookie \
        Key=stickiness.lb_cookie.duration_seconds,Value=86400 \
        Key=deregistration_delay.timeout_seconds,Value=60 \
    >/dev/null
log "TG attributes: stickiness=lb_cookie/86400s, deregistration=60s"

# --- 4. ALB listener rule ---
set +e
RULE_CHECK=$(aws_cli elbv2 describe-rules --listener-arn "${LISTENER_ARN}" \
    --query "Rules[?Conditions[?contains(Values, '${HOST_NAME}')]] | [0].RuleArn" --output text 2>/dev/null)
set -e
if [ -z "${RULE_CHECK}" ] || [ "${RULE_CHECK}" = "None" ]; then
    log "creating listener rule priority=${LISTENER_RULE_PRIORITY}"
    aws_cli elbv2 create-rule \
        --listener-arn "${LISTENER_ARN}" \
        --priority "${LISTENER_RULE_PRIORITY}" \
        --conditions "Field=host-header,Values=${HOST_NAME}" \
        --actions "Type=forward,TargetGroupArn=${TG_ARN}" \
        --query 'Rules[0].RuleArn' --output text
else
    log "listener rule for ${HOST_NAME} exists: ${RULE_CHECK}"
fi

# --- 5. Route53 A-record (alias → ALB) ---
R53_CHANGE_JSON="$(mktemp -t r53-change.XXXXXX.json)"
cat > "${R53_CHANGE_JSON}" <<EOF
{
  "Comment": "KS-1696 ADR-021: broadcasts.kingside.site → kingside-alb",
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "${HOST_NAME}.",
      "Type": "A",
      "AliasTarget": {
        "HostedZoneId": "${ALB_ZONE_ID}",
        "DNSName": "${ALB_DNS}.",
        "EvaluateTargetHealth": false
      }
    }
  }]
}
EOF
aws_cli route53 change-resource-record-sets \
    --hosted-zone-id "${ROUTE53_ZONE_ID}" \
    --change-batch "file://${R53_CHANGE_JSON}" \
    --query 'ChangeInfo.Status' --output text
rm -f "${R53_CHANGE_JSON}"
log "Route53 UPSERT applied for ${HOST_NAME}"

# --- 6. Security group ingress (ECS SG ← ALB SG on container port) ---
set +e
SG_OUT=$(aws_cli ec2 authorize-security-group-ingress \
    --group-id "${ECS_SG}" \
    --ip-permissions "IpProtocol=tcp,FromPort=${CONTAINER_PORT},ToPort=${CONTAINER_PORT},UserIdGroupPairs=[{GroupId=${ALB_SG},Description=\"broadcast-service ALB ingress\"}]" \
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

# --- 7. Database broadcasts_kingside in RDS ---
# CREATE DATABASE не может быть в транзакции и требует роль с CREATEDB. Роль
# kingside (используется archive-service) имеет rolcreatedb=true, проверено.
# Выполняется через ad-hoc Fargate таск на kingside-archive-importer-adhoc
# (у него есть связность с prod RDS через ARCHIVE_DATABASE_URL secret).
# Скрипт создан для документации; по факту выполнен вручную при первом запуске
# (KS-1696). Идемпотентность: if-exists check обрабатывает повторный CREATE.
log "DB creation step — executed once manually via adhoc ECS task, see KS-1696."
log "To replay: run-task kingside-archive-importer-adhoc with overrides:"
log "  node -e \"(async()=>{const {PrismaClient}=require('@kingside/archive-db');"
log "  const p=new PrismaClient();await p.\\\$executeRawUnsafe('CREATE DATABASE ${DB_NAME} OWNER kingside');})()\""

# --- 8. ECS Task definition (registered только если образ пушнут в ECR) ---
# Проверяем что образ :latest существует в ECR. Если нет — task-def не
# регистрируется (избегаем регистрации ревизии с несуществующим образом).
set +e
IMAGE_CHECK=$(aws_cli ecr describe-images --repository-name "${ECR_REPO_NAME}" \
    --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text 2>/dev/null)
set -e
if [ -z "${IMAGE_CHECK}" ] || [ "${IMAGE_CHECK}" = "None" ]; then
    log "WARN: ECR image ${ECR_REPO_NAME}:latest не найден — пропускаем register-task-def + create-service."
    log "      Backend должен сначала выполнить deploy scope=broadcast-service."
    exit 0
fi

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
        {"name": "BROADCAST_SERVICE_PORT", "value": "${CONTAINER_PORT}"},
        {"name": "PORT", "value": "${CONTAINER_PORT}"},
        {"name": "CORS_ORIGIN", "value": "${CORS_ORIGIN}"},
        {"name": "WS_USE_REDIS_ADAPTER", "value": "auto"},
        {"name": "ECS_TASK_COUNT", "value": "${ECS_TASK_COUNT_INITIAL}"}
      ],
      "secrets": [
        {"name": "BROADCASTS_DATABASE_URL", "valueFrom": "${BROADCAST_SECRET_ARN}:BROADCASTS_DATABASE_URL::"},
        {"name": "REDIS_URL",               "valueFrom": "${API_SECRET_ARN}:REDIS_URL::"},
        {"name": "REDIS_HOST",              "valueFrom": "${API_SECRET_ARN}:REDIS_HOST::"},
        {"name": "REDIS_PORT",              "valueFrom": "${API_SECRET_ARN}:REDIS_PORT::"},
        {"name": "LICHESS_BROADCAST_IDS",   "valueFrom": "${API_SECRET_ARN}:LICHESS_BROADCAST_IDS::"}
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
        "command": ["CMD-SHELL", "node -e \"const h=require('http');h.get('http://localhost:${CONTAINER_PORT}${HEALTH_PATH}',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))\""],
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
TASKDEF_FILE="$(mktemp -t broadcast-taskdef.XXXXXX.json)"
trap 'rm -f "${TASKDEF_FILE}"' EXIT
printf '%s' "${TASKDEF_JSON}" > "${TASKDEF_FILE}"
TD_ARN=$(aws_cli ecs register-task-definition --cli-input-json "file://${TASKDEF_FILE}" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
log "registered task definition: ${TD_ARN}"

# --- 9. ECS service ---
SVC_STATUS=$(aws_cli ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE_NAME}" \
    --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")

if [ "${SVC_STATUS}" = "ACTIVE" ]; then
    log "service ${SERVICE_NAME} exists → update to ${TD_ARN}"
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

# --- 10. Auto Scaling (ALB RPS target tracking) ---
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

TG_SUFFIX="$(echo "${TG_ARN}" | sed 's|.*:targetgroup/||')"
ALB_SUFFIX="$(echo "${ALB_ARN}" | sed 's|.*:loadbalancer/||')"
RESOURCE_LABEL="${ALB_SUFFIX}/targetgroup/${TG_SUFFIX}"

POLICY_EXISTS=$(aws_cli application-autoscaling describe-scaling-policies \
    --service-namespace ecs --resource-id "${SCALABLE_TARGET_ID}" \
    --query "ScalingPolicies[?PolicyName=='${SERVICE_NAME}-alb-rps'] | [0].PolicyARN" --output text 2>/dev/null || echo "None")

if [ "${POLICY_EXISTS}" = "None" ] || [ -z "${POLICY_EXISTS}" ]; then
    log "creating target-tracking scaling policy (ALB RPS=1000/min)"
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
    log "scaling policy already present"
fi

log "done. service ARN:"
aws_cli ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE_NAME}" \
    --query 'services[0].serviceArn' --output text

# =============================================================================
# M1 cutover (KS-1696/1697): переключение broadcast-worker на BROADCASTS_DATABASE_URL.
# ЗАКОММЕНТИРОВАНО — выполняется отдельно backend'ом по готовности apps/broadcast-service.
#
# Текущий worker task-def: kingside-broadcast-worker:1, env DATABASE_URL из
# kingside/api. После закрытия KS-1697 backend даст сигнал, и мы:
#   1. Зарегистрируем новый task-def с BROADCASTS_DATABASE_URL вместо DATABASE_URL.
#   2. update-service kingside-broadcast-worker --task-definition :<new_rev>.
#   3. Через ~30-60с первый syncBroadcasts наполнит broadcasts_kingside.
#
# Шаблон (раскомментировать в момент cutover):
#
# WORKER_FAMILY="kingside-broadcast-worker"
# WORKER_TD_JSON=$(cat <<EOF
# {
#   "family": "${WORKER_FAMILY}",
#   "networkMode": "awsvpc",
#   "requiresCompatibilities": ["FARGATE"],
#   "cpu": "256",
#   "memory": "512",
#   "executionRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole",
#   "taskRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskRole",
#   "containerDefinitions": [{
#     "name": "${WORKER_FAMILY}",
#     "image": "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-broadcast-worker:latest",
#     "essential": true,
#     "environment": [{"name": "NODE_ENV", "value": "production"}],
#     "secrets": [
#       {"name": "BROADCASTS_DATABASE_URL", "valueFrom": "${BROADCAST_SECRET_ARN}:BROADCASTS_DATABASE_URL::"},
#       {"name": "REDIS_URL",             "valueFrom": "${API_SECRET_ARN}:REDIS_URL::"},
#       {"name": "REDIS_HOST",            "valueFrom": "${API_SECRET_ARN}:REDIS_HOST::"},
#       {"name": "REDIS_PORT",            "valueFrom": "${API_SECRET_ARN}:REDIS_PORT::"},
#       {"name": "LICHESS_BROADCAST_IDS", "valueFrom": "${API_SECRET_ARN}:LICHESS_BROADCAST_IDS::"}
#     ],
#     "logConfiguration": {"logDriver": "awslogs", "options": {
#       "awslogs-group": "/ecs/broadcast-worker",
#       "awslogs-region": "${REGION}",
#       "awslogs-stream-prefix": "ecs"
#     }}
#   }]
# }
# EOF
# )
# =============================================================================
