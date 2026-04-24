#!/bin/bash
# Deploy Kingside to AWS (S3 + CloudFront + ECR + ECS)
#
# Usage:
#   bash scripts/deploy-aws.sh            — auto-detect scope
#   bash scripts/deploy-aws.sh frontend   — force frontend only
#   bash scripts/deploy-aws.sh api        — force API only
#   bash scripts/deploy-aws.sh game-service — force game-service only
#   bash scripts/deploy-aws.sh all        — force full deploy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# AWS config
REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID="342946498289"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-api"
ECR_URI_GAME="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-game-service"
ECR_URI_BROADCAST_SERVICE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-broadcast-service"
ECR_URI_ARCHIVE_SERVICE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-archive-service"
S3_BUCKET="kingside-frontend-${ACCOUNT_ID}"
CF_DISTRIBUTION="E1ECCUC177NSGI"
ECS_CLUSTER="kingside"
ECS_SERVICE="kingside-api"
ECS_SERVICE_GAME="kingside-game-service"
# ADR-021: отдельный сервис для REST+WS broadcasts на broadcasts.kingside.site.
# ADR-022 (KS-1709): kingside-broadcast-worker удалён, sync-цикл выполняется внутри broadcast-service.
ECS_SERVICE_BROADCAST_SERVICE="kingside-broadcast-service"
# ADR-019: единый образ archive-service обслуживает два ECS-сервиса: HTTP и importer.
ECS_SERVICE_ARCHIVE_SERVICE="kingside-archive-service"
ECS_SERVICE_ARCHIVE_IMPORTER="kingside-archive-importer"
# Prod values hardcoded — DO NOT use ${VITE_*:-default}:
# локальные VITE_* (dev: ws://localhost:3002) в env webhook-server/хоста
# перебивали дефолты и попадали в prod-бандл. См. KS-1570.
PROD_API_URL="https://kingside.site"
# VITE_API_URL теперь указывает на api-субдомен (KS-1643 / ADR-017).
# VITE_APP_ORIGIN остаётся на корне — для Telegram OAuth redirect.
PROD_VITE_API_URL="https://api.kingside.site"
# VITE_ARCHIVE_URL — выделенный поддомен для archive-service (KS-1662 / ADR-018 §2.7).
# Fallback на VITE_API_URL во фронте не используется: archiveUrl.js бросает исключение
# при загрузке модуля, если переменная не задана.
PROD_VITE_ARCHIVE_URL="https://archive.kingside.site"
# VITE_BROADCAST_URL — выделенный поддомен для broadcast-service (KS-1696 / ADR-021 §6).
# Fallback на VITE_API_URL не используется: broadcastUrl.ts кидает Error при загрузке
# модуля, если переменная не задана (broadcast-страницы eager-loaded в App.tsx).
PROD_VITE_BROADCAST_URL="https://broadcasts.kingside.site"
PROD_GAME_URL="wss://game.kingside.site"
PROD_GA4_ID="G-9HF8RVMK8K"
# KS-1820: feature-flag раздела «Уроки». На проде явно выключен, во фронте
# также есть fallback на import.meta.env.DEV (см. KS-1820 / commit 378d2b8c).
PROD_VITE_FEATURE_LESSONS="false"
DEPLOY_COMMIT_FILE="$REPO_DIR/.deploy-commit-aws"

# Load .env
if [ -f "$REPO_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$REPO_DIR/.env"
    set +a
fi

export AWS_DEFAULT_REGION="$REGION"

# --- Helpers ---

fix_symlinks() {
    for d in apps/web/node_modules apps/api/node_modules; do
        if [ -L "$REPO_DIR/$d" ] && [ "$(readlink "$REPO_DIR/$d")" = "$REPO_DIR/$d" ]; then
            echo "[pre-deploy] Removed circular symlink: $d"
            rm "$REPO_DIR/$d"
        fi
    done
}

ensure_deps() {
    if [ ! -d "$REPO_DIR/node_modules/vite" ]; then
        echo "[pre-deploy] node_modules missing — npm install..."
        npm install --prefix "$REPO_DIR" 2>&1 | tail -3
    fi
}

get_deployed_commit() {
    cat "$DEPLOY_COMMIT_FILE" 2>/dev/null || echo ""
}

save_deployed_commit() {
    local commit
    commit=$(git -C "$REPO_DIR" rev-parse HEAD)
    echo "$commit" > "$DEPLOY_COMMIT_FILE"
    echo "  Saved deploy commit: ${commit:0:7}"
}

detect_deploy_scope() {
    local deployed_commit
    deployed_commit=$(get_deployed_commit)

    if [ -z "$deployed_commit" ]; then
        echo "all"
        return
    fi

    local current_commit
    current_commit=$(git -C "$REPO_DIR" rev-parse HEAD)

    if [ "$deployed_commit" = "$current_commit" ]; then
        echo "none"
        return
    fi

    if ! git -C "$REPO_DIR" cat-file -t "$deployed_commit" &>/dev/null; then
        echo "all"
        return
    fi

    local changed_files
    changed_files=$(git -C "$REPO_DIR" diff --name-only "$deployed_commit"..HEAD)

    local has_frontend=false
    local has_api=false
    local has_game=false
    local has_broadcast_service=false
    local has_archive_service=false

    while IFS= read -r file; do
        [ -z "$file" ] && continue
        case "$file" in
            apps/web/*)
                has_frontend=true ;;
            apps/api/*)
                has_api=true ;;
            apps/game-service/*)
                has_game=true ;;
            apps/broadcast-service/*)
                has_broadcast_service=true ;;
            packages/broadcasts-db/*)
                has_broadcast_service=true ;;
            apps/archive-service/*)
                has_archive_service=true ;;
            packages/archive-db/*)
                has_archive_service=true ;;
            packages/shared/*)
                has_frontend=true
                has_api=true
                has_game=true
                has_broadcast_service=true
                has_archive_service=true ;;
            scripts/*|infra/*|justfile)
                has_frontend=true
                has_api=true
                has_game=true
                has_broadcast_service=true
                has_archive_service=true ;;
        esac
    done <<< "$changed_files"

    # Multiple services changed → deploy all
    local count=0
    $has_frontend && count=$((count + 1))
    $has_api && count=$((count + 1))
    $has_game && count=$((count + 1))
    $has_broadcast_service && count=$((count + 1))
    $has_archive_service && count=$((count + 1))

    if [ "$count" -gt 1 ]; then
        echo "all"
    elif $has_frontend; then
        echo "frontend"
    elif $has_api; then
        echo "api"
    elif $has_game; then
        echo "game-service"
    elif $has_broadcast_service; then
        echo "broadcast-service"
    elif $has_archive_service; then
        echo "archive-service"
    else
        echo "none"
    fi
}

# --- Main ---

FORCE_SCOPE="${1:-auto}"

fix_symlinks
ensure_deps

if [ "$FORCE_SCOPE" = "auto" ]; then
    SCOPE=$(detect_deploy_scope)
    if [ "$SCOPE" = "none" ]; then
        echo "No changes since last deploy ($(get_deployed_commit | head -c 7)). Nothing to do."
        exit 0
    fi
    echo "Auto-detected scope: $SCOPE"
else
    SCOPE="$FORCE_SCOPE"
    echo "Forced scope: $SCOPE"
fi

DEPLOY_FRONTEND=false
DEPLOY_API=false
DEPLOY_GAME=false
DEPLOY_BROADCAST_SERVICE=false
DEPLOY_ARCHIVE_SERVICE=false

case "$SCOPE" in
    frontend)           DEPLOY_FRONTEND=true ;;
    api)                DEPLOY_API=true ;;
    game-service)       DEPLOY_GAME=true ;;
    broadcast-service)  DEPLOY_BROADCAST_SERVICE=true ;;
    archive-service)    DEPLOY_ARCHIVE_SERVICE=true ;;
    workers)            DEPLOY_BROADCAST_SERVICE=true; DEPLOY_ARCHIVE_SERVICE=true ;;
    all)                DEPLOY_FRONTEND=true; DEPLOY_API=true; DEPLOY_GAME=true; DEPLOY_BROADCAST_SERVICE=true; DEPLOY_ARCHIVE_SERVICE=true ;;
    *)                  echo "Unknown scope: $SCOPE"; exit 1 ;;
esac

echo ""
echo "=== Deploy Kingside to AWS ($SCOPE) ==="
echo ""

# --- Frontend: vite build → S3 sync → CloudFront invalidation ---
if $DEPLOY_FRONTEND; then
    echo "[frontend] Building (VITE_API_URL=$PROD_VITE_API_URL, VITE_ARCHIVE_URL=$PROD_VITE_ARCHIVE_URL, VITE_BROADCAST_URL=$PROD_VITE_BROADCAST_URL, VITE_APP_ORIGIN=$PROD_API_URL, VITE_GAME_URL=$PROD_GAME_URL, VITE_GA4_ID=$PROD_GA4_ID, VITE_FEATURE_LESSONS=$PROD_VITE_FEATURE_LESSONS)..."
    VITE_API_URL="$PROD_VITE_API_URL" VITE_ARCHIVE_URL="$PROD_VITE_ARCHIVE_URL" VITE_BROADCAST_URL="$PROD_VITE_BROADCAST_URL" VITE_APP_ORIGIN="$PROD_API_URL" VITE_GAME_URL="$PROD_GAME_URL" VITE_GA4_ID="$PROD_GA4_ID" VITE_FEATURE_LESSONS="$PROD_VITE_FEATURE_LESSONS" npm run build --prefix "$REPO_DIR" --workspace=apps/web
    echo "  Built: $REPO_DIR/apps/web/dist"

    echo "[frontend] Syncing to S3..."
    aws s3 sync "$REPO_DIR/apps/web/dist/" "s3://${S3_BUCKET}/" --delete --quiet
    echo "  Synced to s3://$S3_BUCKET/"

    echo "[frontend] Invalidating CloudFront cache..."
    aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION" \
        --paths "/*" --query 'Invalidation.Id' --output text
    echo "  CloudFront invalidation created."
fi

# --- API: docker build → ECR push → ECS update ---
if $DEPLOY_API; then
    echo "[api] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null

    echo "[api] Building Docker image..."
    docker build -t kingside-api:latest -f "$REPO_DIR/apps/api/Dockerfile" "$REPO_DIR"

    echo "[api] Pushing to ECR..."
    docker tag kingside-api:latest "${ECR_URI}:latest"
    docker push "${ECR_URI}:latest" 2>&1 | tail -3

    echo "[api] Running Prisma migrations..."
    VPC_ID=$(aws ec2 describe-vpcs --filters "Name=cidr-block,Values=10.0.0.0/16" --query 'Vpcs[0].VpcId' --output text)
    MIGRATE_SUBNET=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.1.0/24" --query 'Subnets[0].SubnetId' --output text)
    MIGRATE_SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=kingside-ecs-sg" "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text)
    MIGRATE_TASK=$(aws ecs run-task \
        --cluster "$ECS_CLUSTER" --task-definition kingside-api --launch-type FARGATE \
        --network-configuration "awsvpcConfiguration={subnets=[$MIGRATE_SUBNET],securityGroups=[$MIGRATE_SG],assignPublicIp=ENABLED}" \
        --overrides '{"containerOverrides":[{"name":"kingside-api","command":["sh","-c","cd /app/apps/api && npx prisma migrate deploy"]}]}' \
        --query 'tasks[0].taskArn' --output text)
    aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$MIGRATE_TASK"
    MIGRATE_EXIT=$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$MIGRATE_TASK" \
        --query 'tasks[0].containers[0].exitCode' --output text)
    if [ "$MIGRATE_EXIT" != "0" ]; then
        echo "  ERROR: Prisma migrate failed (exit $MIGRATE_EXIT). Aborting deploy."
        exit 1
    fi
    echo "  Migrations applied."

    echo "[api] Updating ECS service..."
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
        --force-new-deployment --query 'service.deployments[0].status' --output text
    echo "  ECS service update initiated."
fi

# --- Game Service: docker build → ECR push → ECS update ---
if $DEPLOY_GAME; then
    echo "[game-service] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null

    echo "[game-service] Building Docker image..."
    docker build -t kingside-game-service:latest -f "$REPO_DIR/apps/game-service/Dockerfile" "$REPO_DIR"

    echo "[game-service] Pushing to ECR..."
    docker tag kingside-game-service:latest "${ECR_URI_GAME}:latest"
    docker push "${ECR_URI_GAME}:latest" 2>&1 | tail -3

    echo "[game-service] Updating ECS service..."
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_GAME" \
        --force-new-deployment --query 'service.deployments[0].status' --output text
    echo "  ECS service update initiated."
fi

# --- Broadcast Service (apps/broadcast-service): docker build → ECR push → ECS update ---
# ADR-021: REST+WS для /broadcasts переезжает из apps/api в отдельный apps/broadcast-service
# на broadcasts.kingside.site. Образ kingside-broadcast-service обслуживает один ECS-сервис
# kingside-broadcast-service (HTTP+WS на порту 3004). Sticky sessions включены на ALB TG
# kingside-broadcasts-api (lb_cookie, WS-critical).
# Инфра — scripts/broadcast-service-aws-setup.sh (KS-1696).
if $DEPLOY_BROADCAST_SERVICE; then
    echo "[broadcast-service] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null

    echo "[broadcast-service] Building Docker image..."
    docker build -t kingside-broadcast-service:latest -f "$REPO_DIR/apps/broadcast-service/Dockerfile" "$REPO_DIR"

    echo "[broadcast-service] Pushing to ECR..."
    docker tag kingside-broadcast-service:latest "${ECR_URI_BROADCAST_SERVICE}:latest"
    docker push "${ECR_URI_BROADCAST_SERVICE}:latest" 2>&1 | tail -3

    SVC_STATUS=$(aws ecs describe-services \
        --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_BROADCAST_SERVICE" \
        --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")

    if [ "$SVC_STATUS" = "ACTIVE" ]; then
        # KS-1817: Prisma migrations для broadcasts-db (отдельная БД broadcasts_kingside).
        # До KS-1817 миграции этой БД накатывались вручную → 24.04 миграция 20260424093000
        # не приехала вместе с деплоем KS-1813 и /rounds падал 500. Шаг симметричен api-блоку
        # (строки 252-268), дублирование VPC_ID/subnet/sg — принято: выносить общий helper —
        # follow-up рефакторинг.
        echo "[broadcast-service] Running Prisma migrations (broadcasts-db)..."
        VPC_ID=$(aws ec2 describe-vpcs --filters "Name=cidr-block,Values=10.0.0.0/16" --query 'Vpcs[0].VpcId' --output text)
        MIGRATE_SUBNET=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.1.0/24" --query 'Subnets[0].SubnetId' --output text)
        MIGRATE_SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=kingside-ecs-sg" "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text)
        MIGRATE_TASK=$(aws ecs run-task \
            --cluster "$ECS_CLUSTER" --task-definition kingside-broadcast-service --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[$MIGRATE_SUBNET],securityGroups=[$MIGRATE_SG],assignPublicIp=ENABLED}" \
            --overrides '{"containerOverrides":[{"name":"kingside-broadcast-service","command":["sh","-c","cd /app/packages/broadcasts-db && npx prisma migrate deploy --schema=./prisma/schema.prisma"]}]}' \
            --query 'tasks[0].taskArn' --output text)
        aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$MIGRATE_TASK"
        MIGRATE_EXIT=$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$MIGRATE_TASK" \
            --query 'tasks[0].containers[0].exitCode' --output text)
        if [ "$MIGRATE_EXIT" != "0" ]; then
            echo "  ERROR: Prisma migrate failed (exit $MIGRATE_EXIT). Aborting deploy."
            exit 1
        fi
        echo "  Migrations applied."

        echo "[broadcast-service] Updating ECS service..."
        aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_BROADCAST_SERVICE" \
            --force-new-deployment --query 'service.deployments[0].status' --output text
        echo "  ECS service update initiated."

        # KS-1817: post-deploy smoke-gate. Ждём rollout до stable (max ~10 min),
        # затем curl на реальный broadcast. Если /rounds != 200 — зафейлить деплой,
        # оператор может откатить через update-service --task-definition <prev-rev>.
        # SMOKE_BROADCAST_ID можно переопределить через env, дефолт — 2026 Chess.com Open.
        SMOKE_BROADCAST_ID="${SMOKE_BROADCAST_ID:-f427e6de-10d7-42b9-9aec-58154a92d270}"
        echo "[broadcast-service] Waiting for rollout to stabilize..."
        aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_BROADCAST_SERVICE"
        echo "[broadcast-service] Smoke-check /rounds on broadcast $SMOKE_BROADCAST_ID..."
        SMOKE_CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "https://broadcasts.kingside.site/${SMOKE_BROADCAST_ID}/rounds" || echo "000")
        if [ "$SMOKE_CODE" != "200" ]; then
            echo "  ERROR: smoke /rounds returned $SMOKE_CODE (expected 200). Likely DB schema regression or service unavailable."
            echo "  Rollback: aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE_BROADCAST_SERVICE --task-definition <previous-revision>"
            exit 1
        fi
        echo "  Smoke /rounds OK (HTTP 200)."
    else
        echo "[broadcast-service] ECS service '$ECS_SERVICE_BROADCAST_SERVICE' not found (status=$SVC_STATUS)."
        echo "[broadcast-service] Run scripts/broadcast-service-aws-setup.sh after first image push to register task-def + create service."
    fi
fi

# --- Archive Service (apps/archive-service): docker build → ECR push → ECS update ---
# ADR-019: единый образ kingside-archive-service обслуживает два ECS-сервиса:
#   - kingside-archive-service — HTTP (node dist/main.js, порт 3003)
#   - kingside-archive-importer — importer/scheduler (node dist/importer-main.js, порт 3004)
# Оба тянут tag :latest, поэтому push идёт один раз, а force-new-deployment — на каждый.
# Сервисы создаются один раз через scripts/archive-service-aws-setup.sh (HTTP) +
# отдельная task-def для importer (см. docs/adr/019-...).
if $DEPLOY_ARCHIVE_SERVICE; then
    echo "[archive-service] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null

    echo "[archive-service] Building Docker image..."
    docker build -t kingside-archive-service:latest -f "$REPO_DIR/apps/archive-service/Dockerfile" "$REPO_DIR"

    echo "[archive-service] Pushing to ECR..."
    docker tag kingside-archive-service:latest "${ECR_URI_ARCHIVE_SERVICE}:latest"
    docker push "${ECR_URI_ARCHIVE_SERVICE}:latest" 2>&1 | tail -3

    for svc in "$ECS_SERVICE_ARCHIVE_SERVICE" "$ECS_SERVICE_ARCHIVE_IMPORTER"; do
        SVC_STATUS=$(aws ecs describe-services \
            --cluster "$ECS_CLUSTER" --services "$svc" \
            --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")

        if [ "$SVC_STATUS" = "ACTIVE" ]; then
            echo "[archive-service] Updating ECS service $svc..."
            aws ecs update-service --cluster "$ECS_CLUSTER" --service "$svc" \
                --force-new-deployment --query 'service.deployments[0].status' --output text
            echo "  ECS service $svc update initiated."
        else
            echo "[archive-service] ECS service '$svc' not found (status=$SVC_STATUS). Skipping."
        fi
    done
fi

# Save deployed commit
save_deployed_commit

echo ""
echo "=== Deploy complete ($SCOPE) ==="
