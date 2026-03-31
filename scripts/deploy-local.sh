#!/bin/bash
# Full deploy: frontend + API (blue-green zero-downtime)
# Usage: bash scripts/deploy-local.sh [--skip-frontend-build]
#
# For partial deploys use:
#   bash scripts/deploy-frontend.sh  — frontend only
#   bash scripts/deploy-api.sh       — API only

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-common.sh"

SKIP_FRONTEND_BUILD="${1:-}"

fix_symlinks
ensure_deps

echo "=== Full Deploy Kingside ==="
echo "Repo: $REPO_DIR"
echo "Server: $REMOTE_HOST:$REMOTE_DIR"
echo ""

# 1. Build frontend locally
if [ "$SKIP_FRONTEND_BUILD" != "--skip-frontend-build" ]; then
    echo "[1/6] Building frontend (VITE_API_URL=$PROD_API_URL)..."
    VITE_API_URL="$PROD_API_URL" npm run build --workspace=apps/web
    echo "  Built: $WEB_DIST"
else
    echo "[1/6] Frontend build skipped (--skip-frontend-build)"
    if [ ! -d "$WEB_DIST" ]; then
        echo "ERROR: $WEB_DIST not found. Run without --skip-frontend-build."
        exit 1
    fi
fi

# 2. Sync code to server
echo "[2/6] Syncing code to server..."
sync_code

# 3. Deploy frontend static
echo "[3/6] Deploying frontend static..."
rsync -az --delete "$WEB_DIST/" "$REMOTE_HOST:/var/www/kingside/"
echo "  Frontend deployed to /var/www/kingside."

# 4. Setup nginx
echo "[4/6] Setting up nginx..."
setup_nginx

# 5. Zero-downtime blue-green deploy API
echo "[5/6] Zero-downtime deploy API (blue-green)..."
ssh "$REMOTE_HOST" "cd $REMOTE_DIR && bash scripts/deploy-server-zero-downtime.sh"

# 6. Check cron jobs
echo "[6/6] Checking cron jobs..."
check_cron

echo ""
echo "=== Deploy complete ==="
echo ""
echo "Check:"
echo "  ssh $REMOTE_HOST 'cd $REMOTE_DIR && bash scripts/server-check.sh'"
