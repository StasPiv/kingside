#!/usr/bin/env bash
# KS-2195: Synthetic v2 — deploy synthetic-bot-service.
#
# Build → push в ECR → register new task-def revision (с pinned image:<sha>) →
# update-service --force-new-deployment → wait services-stable.
#
# Использование:
#   scripts/deploy-synthetic-bot.sh           # обычный деплой текущего main
#   scripts/deploy-synthetic-bot.sh --skip-build  # только update-service на :latest
#
# Атомарность образа: сначала пушим :<sha>, регистрируем task-def на этот SHA,
# и только после успешного wait services-stable перетыкаем :latest. Если
# rollout упадёт — :latest остаётся на предыдущем рабочем digest (см. шапку
# scripts/deploy-aws.sh, KS-1826/KS-2086).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REGION="${REGION:-eu-central-1}"
ACCOUNT_ID="${ACCOUNT_ID:-342946498289}"
CLUSTER="${CLUSTER:-kingside}"
SERVICE_NAME="${SERVICE_NAME:-kingside-synthetic-bot-service}"
TASK_FAMILY="${TASK_FAMILY:-kingside-synthetic-bot-service}"
ECR_REPO_NAME="${ECR_REPO_NAME:-kingside-synthetic-bot-service}"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO_NAME}"
DOCKERFILE_PATH="${DOCKERFILE_PATH:-${REPO_DIR}/apps/synthetic-bot-service/Dockerfile}"

SKIP_BUILD=false
if [ "${1:-}" = "--skip-build" ]; then
    SKIP_BUILD=true
fi

log() { printf '[deploy-synthetic-bot] %s\n' "$*"; }

DEPLOY_SHA="$(git -C "${REPO_DIR}" rev-parse --short HEAD)"
log "deploy SHA: ${DEPLOY_SHA}"

if ! ${SKIP_BUILD}; then
    if [ ! -f "${DOCKERFILE_PATH}" ]; then
        log "ERROR: Dockerfile не найден: ${DOCKERFILE_PATH}"
        exit 1
    fi

    log "ECR login..."
    aws --region "${REGION}" ecr get-login-password \
        | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

    log "Building image kingside-synthetic-bot-service:${DEPLOY_SHA}..."
    docker build \
        -t "kingside-synthetic-bot-service:${DEPLOY_SHA}" \
        -f "${DOCKERFILE_PATH}" \
        "${REPO_DIR}"

    log "Pushing ${ECR_URI}:${DEPLOY_SHA}..."
    docker tag "kingside-synthetic-bot-service:${DEPLOY_SHA}" "${ECR_URI}:${DEPLOY_SHA}"
    docker push "${ECR_URI}:${DEPLOY_SHA}"
fi

# Если task-def family ещё не существует — отправляем в setup-script,
# он зарегистрирует первый revision с правильным конфигом (CPU/mem/secrets/SG/...).
set +e
LAST_TD=$(aws --region "${REGION}" ecs describe-task-definition \
    --task-definition "${TASK_FAMILY}" --query 'taskDefinition.taskDefinitionArn' \
    --output text 2>/dev/null)
set -e

if [ -z "${LAST_TD}" ] || [ "${LAST_TD}" = "None" ]; then
    log "task-def family ${TASK_FAMILY} ещё не существует — запускаем bootstrap."
    bash "${SCRIPT_DIR}/synthetic-bot-aws-setup.sh"
    log "bootstrap завершён. Делаю force-new-deployment..."
    aws --region "${REGION}" ecs update-service \
        --cluster "${CLUSTER}" --service "${SERVICE_NAME}" \
        --force-new-deployment --query 'service.deployments[0].status' --output text
else
    # Регистрируем новый revision с pinned image:<sha>.
    log "registering new task-def revision (image=:${DEPLOY_SHA})..."
    NEW_TD_JSON=$(aws --region "${REGION}" ecs describe-task-definition \
        --task-definition "${TASK_FAMILY}" \
        --query 'taskDefinition.{family:family,networkMode:networkMode,requiresCompatibilities:requiresCompatibilities,cpu:cpu,memory:memory,executionRoleArn:executionRoleArn,taskRoleArn:taskRoleArn,containerDefinitions:containerDefinitions}' \
        --output json)
    NEW_TD_JSON=$(echo "${NEW_TD_JSON}" | python3 -c "
import json, sys
td = json.load(sys.stdin)
for c in td['containerDefinitions']:
    if c.get('name') == '${TASK_FAMILY}':
        c['image'] = '${ECR_URI}:${DEPLOY_SHA}'
print(json.dumps(td))
")
    NEW_TD_FILE="$(mktemp -t synth-bot-newtd.XXXXXX.json)"
    trap 'rm -f "${NEW_TD_FILE}"' EXIT
    printf '%s' "${NEW_TD_JSON}" > "${NEW_TD_FILE}"
    NEW_TD_ARN=$(aws --region "${REGION}" ecs register-task-definition \
        --cli-input-json "file://${NEW_TD_FILE}" \
        --query 'taskDefinition.taskDefinitionArn' --output text)
    log "new revision: ${NEW_TD_ARN}"

    log "update-service ${SERVICE_NAME} → ${NEW_TD_ARN}"
    aws --region "${REGION}" ecs update-service \
        --cluster "${CLUSTER}" --service "${SERVICE_NAME}" \
        --task-definition "${NEW_TD_ARN}" --force-new-deployment \
        --query 'service.deployments[0].status' --output text
fi

log "Waiting for ECS service to stabilize (timeout ~10 min)..."
aws --region "${REGION}" ecs wait services-stable \
    --cluster "${CLUSTER}" --services "${SERVICE_NAME}"
log "Service stable."

# Атомарный move :latest → :<sha> — после стабилизации деплоя.
if ! ${SKIP_BUILD}; then
    log "Moving :latest tag to ${DEPLOY_SHA}..."
    MANIFEST=$(aws --region "${REGION}" ecr batch-get-image \
        --repository-name "${ECR_REPO_NAME}" --image-ids imageTag="${DEPLOY_SHA}" \
        --query 'images[0].imageManifest' --output text)
    aws --region "${REGION}" ecr put-image \
        --repository-name "${ECR_REPO_NAME}" \
        --image-tag latest \
        --image-manifest "${MANIFEST}" \
        --query 'image.imageId.imageTag' --output text >/dev/null || \
        log "WARN: put-image :latest failed (image may already point to ${DEPLOY_SHA})"
fi

log "done. service status:"
aws --region "${REGION}" ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE_NAME}" \
    --query 'services[0].{status:status,desired:desiredCount,running:runningCount,td:taskDefinition}' \
    --output table
