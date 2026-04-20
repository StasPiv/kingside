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
ECR_URI_BROADCAST="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-broadcast-worker"
ECR_URI_ARCHIVE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-archive-importer"
S3_BUCKET="kingside-frontend-${ACCOUNT_ID}"
CF_DISTRIBUTION="E1ECCUC177NSGI"
ECS_CLUSTER="kingside"
ECS_SERVICE="kingside-api"
ECS_SERVICE_GAME="kingside-game-service"
ECS_SERVICE_BROADCAST="kingside-broadcast-worker"
ECS_SERVICE_ARCHIVE="kingside-archive-importer"
# Prod values hardcoded — DO NOT use ${VITE_*:-default}:
# локальные VITE_* (dev: ws://localhost:3002) в env webhook-server/хоста
# перебивали дефолты и попадали в prod-бандл. См. KS-1570.
PROD_API_URL="https://kingside.site"
PROD_GAME_URL="wss://game.kingside.site"
PROD_GA4_ID="G-9HF8RVMK8K"
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
    local has_broadcast=false
    local has_archive=false

    while IFS= read -r file; do
        [ -z "$file" ] && continue
        case "$file" in
            apps/web/*)
                has_frontend=true ;;
            apps/api/*)
                has_api=true ;;
            apps/game-service/*)
                has_game=true ;;
            apps/broadcast-worker/*)
                has_broadcast=true ;;
            apps/archive-importer/*)
                has_archive=true ;;
            packages/shared/*)
                has_frontend=true
                has_api=true
                has_game=true
                has_broadcast=true
                has_archive=true ;;
            scripts/*|infra/*|justfile)
                has_frontend=true
                has_api=true
                has_game=true
                has_broadcast=true
                has_archive=true ;;
        esac
    done <<< "$changed_files"

    # Multiple services changed → deploy all
    local count=0
    $has_frontend && count=$((count + 1))
    $has_api && count=$((count + 1))
    $has_game && count=$((count + 1))
    $has_broadcast && count=$((count + 1))
    $has_archive && count=$((count + 1))

    if [ "$count" -gt 1 ]; then
        echo "all"
    elif $has_frontend; then
        echo "frontend"
    elif $has_api; then
        echo "api"
    elif $has_game; then
        echo "game-service"
    elif $has_broadcast; then
        echo "broadcast-worker"
    elif $has_archive; then
        echo "archive-importer"
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
DEPLOY_BROADCAST=false
DEPLOY_ARCHIVE=false

case "$SCOPE" in
    frontend)          DEPLOY_FRONTEND=true ;;
    api)               DEPLOY_API=true ;;
    game-service)      DEPLOY_GAME=true ;;
    broadcast-worker)  DEPLOY_BROADCAST=true ;;
    archive-importer)  DEPLOY_ARCHIVE=true ;;
    workers)           DEPLOY_BROADCAST=true; DEPLOY_ARCHIVE=true ;;
    all)               DEPLOY_FRONTEND=true; DEPLOY_API=true; DEPLOY_GAME=true; DEPLOY_BROADCAST=true; DEPLOY_ARCHIVE=true ;;
    *)                 echo "Unknown scope: $SCOPE"; exit 1 ;;
esac

echo ""
echo "=== Deploy Kingside to AWS ($SCOPE) ==="
echo ""

# --- Frontend: vite build → S3 sync → CloudFront invalidation ---
if $DEPLOY_FRONTEND; then
    echo "[frontend] Building (VITE_API_URL=$PROD_API_URL, VITE_GAME_URL=$PROD_GAME_URL, VITE_GA4_ID=$PROD_GA4_ID)..."
    VITE_API_URL="$PROD_API_URL" VITE_APP_ORIGIN="$PROD_API_URL" VITE_GAME_URL="$PROD_GAME_URL" VITE_GA4_ID="$PROD_GA4_ID" npm run build --prefix "$REPO_DIR" --workspace=apps/web
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

# --- Broadcast Worker: docker build → ECR push → ECS update ---
if $DEPLOY_BROADCAST; then
    echo "[broadcast-worker] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null

    echo "[broadcast-worker] Building Docker image..."
    docker build -t kingside-broadcast-worker:latest -f "$REPO_DIR/apps/broadcast-worker/Dockerfile" "$REPO_DIR"

    echo "[broadcast-worker] Pushing to ECR..."
    docker tag kingside-broadcast-worker:latest "${ECR_URI_BROADCAST}:latest"
    docker push "${ECR_URI_BROADCAST}:latest" 2>&1 | tail -3

    echo "[broadcast-worker] Updating ECS service..."
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_BROADCAST" \
        --force-new-deployment --query 'service.deployments[0].status' --output text
    echo "  ECS service update initiated."
fi

# --- Archive Importer: docker build → ECR push → ECS update ---
# Воркер читает расписание из БД (archive_sources.schedule) — cron на уровне ОС/ECS не нужен.
if $DEPLOY_ARCHIVE; then
    echo "[archive-importer] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null

    echo "[archive-importer] Building Docker image..."
    docker build -t kingside-archive-importer:latest -f "$REPO_DIR/apps/archive-importer/Dockerfile" "$REPO_DIR"

    echo "[archive-importer] Pushing to ECR..."
    docker tag kingside-archive-importer:latest "${ECR_URI_ARCHIVE}:latest"
    docker push "${ECR_URI_ARCHIVE}:latest" 2>&1 | tail -3

    echo "[archive-importer] Updating ECS service..."
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_ARCHIVE" \
        --force-new-deployment --query 'service.deployments[0].status' --output text
    echo "  ECS service update initiated."
fi

# Save deployed commit
save_deployed_commit

echo ""
echo "=== Deploy complete ($SCOPE) ==="
