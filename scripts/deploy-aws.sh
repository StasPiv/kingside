#!/bin/bash
# Deploy Kingside to AWS (S3 + CloudFront + ECR + ECS)
#
# Usage:
#   bash scripts/deploy-aws.sh            — auto-detect scope
#   bash scripts/deploy-aws.sh frontend   — force frontend only
#   bash scripts/deploy-aws.sh api        — force API only
#   bash scripts/deploy-aws.sh all        — force full deploy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# AWS config
REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID="342946498289"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-api"
S3_BUCKET="kingside-frontend-${ACCOUNT_ID}"
CF_DISTRIBUTION="E1ECCUC177NSGI"
ECS_CLUSTER="kingside"
ECS_SERVICE="kingside-api"
PROD_API_URL="${VITE_API_URL:-https://kingside.site}"
DEPLOY_COMMIT_FILE="$REPO_DIR/.deploy-commit-aws"

# Load .env
if [ -f "$REPO_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$REPO_DIR/.env"
    set +a
fi

# Export AWS credentials from .env
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY:-}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"
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

    while IFS= read -r file; do
        [ -z "$file" ] && continue
        case "$file" in
            apps/web/*|packages/shared/*)
                has_frontend=true ;;
            apps/api/*|docker-compose.yml|Dockerfile|prisma/*|packages/shared/*)
                has_api=true ;;
            scripts/*|infra/*|justfile)
                has_frontend=true
                has_api=true ;;
        esac
    done <<< "$changed_files"

    if $has_frontend && $has_api; then
        echo "all"
    elif $has_frontend; then
        echo "frontend"
    elif $has_api; then
        echo "api"
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

case "$SCOPE" in
    frontend) DEPLOY_FRONTEND=true ;;
    api)      DEPLOY_API=true ;;
    all)      DEPLOY_FRONTEND=true; DEPLOY_API=true ;;
    *)        echo "Unknown scope: $SCOPE"; exit 1 ;;
esac

echo ""
echo "=== Deploy Kingside to AWS ($SCOPE) ==="
echo ""

# --- Frontend: vite build → S3 sync → CloudFront invalidation ---
if $DEPLOY_FRONTEND; then
    echo "[frontend] Building (VITE_API_URL=$PROD_API_URL)..."
    VITE_API_URL="$PROD_API_URL" VITE_APP_ORIGIN="$PROD_API_URL" npm run build --prefix "$REPO_DIR" --workspace=apps/web
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

    echo "[api] Updating ECS service..."
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
        --force-new-deployment --query 'service.deployments[0].status' --output text
    echo "  ECS service update initiated."
fi

# Save deployed commit
save_deployed_commit

echo ""
echo "=== Deploy complete ($SCOPE) ==="
