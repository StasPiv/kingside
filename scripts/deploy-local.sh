#!/bin/bash
# Smart deploy: auto-detects what changed and deploys accordingly
#
# Usage:
#   bash scripts/deploy-local.sh            — auto-detect scope
#   bash scripts/deploy-local.sh frontend   — force frontend only
#   bash scripts/deploy-local.sh api        — force API only
#   bash scripts/deploy-local.sh all        — force full deploy
#
# For standalone partial deploys:
#   bash scripts/deploy-frontend.sh
#   bash scripts/deploy-api.sh

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-common.sh"

FORCE_SCOPE="${1:-auto}"

fix_symlinks
ensure_deps

# Determine deploy scope
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
echo "=== Deploy Kingside ($SCOPE) ==="
echo "Repo: $REPO_DIR"
echo "Server: $REMOTE_HOST:$REMOTE_DIR"
echo ""

# Sync code to server (always needed)
echo "[1] Syncing code to server..."
sync_code

# Frontend deploy
if $DEPLOY_FRONTEND; then
    echo "[frontend] Building (VITE_API_URL=$PROD_API_URL)..."
    VITE_API_URL="$PROD_API_URL" npm run build --workspace=apps/web
    echo "  Built: $WEB_DIST"

    echo "[frontend] Deploying static files..."
    rsync -az --delete "$WEB_DIST/" "$REMOTE_HOST:/var/www/kingside/"
    echo "  Frontend deployed."
fi

# API deploy
if $DEPLOY_API; then
    echo "[api] Setting up nginx..."
    setup_nginx

    echo "[api] Running zero-downtime deploy (blue-green)..."
    ssh "$REMOTE_HOST" "cd $REMOTE_DIR && bash scripts/deploy-server-zero-downtime.sh"

    echo "[api] Checking cron jobs..."
    check_cron
fi

# Save deployed commit
save_deployed_commit

echo ""
echo "=== Deploy complete ($SCOPE) ==="
echo ""
echo "Check:"
echo "  ssh $REMOTE_HOST 'cd $REMOTE_DIR && bash scripts/server-check.sh'"
