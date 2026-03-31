#!/bin/bash
# Deploy only frontend (vite build + copy static to server)
# Usage: bash scripts/deploy-frontend.sh [--skip-build]

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-common.sh"

SKIP_BUILD="${1:-}"

fix_symlinks
ensure_deps

echo "=== Frontend Deploy ==="
echo ""

# 1. Build frontend locally
if [ "$SKIP_BUILD" != "--skip-build" ]; then
    echo "[1/3] Building frontend (VITE_API_URL=$PROD_API_URL)..."
    VITE_API_URL="$PROD_API_URL" npm run build --workspace=apps/web
    echo "  Built: $WEB_DIST"
else
    echo "[1/3] Build skipped (--skip-build)"
    if [ ! -d "$WEB_DIST" ]; then
        echo "ERROR: $WEB_DIST not found. Run without --skip-build."
        exit 1
    fi
fi

# 2. Sync code (for nginx configs, scripts, etc.)
echo "[2/3] Syncing code to server..."
sync_code

# 3. Deploy frontend static files
echo "[3/3] Deploying frontend static..."
rsync -az --delete "$WEB_DIST/" "$REMOTE_HOST:/var/www/kingside/"
echo "  Frontend deployed to /var/www/kingside."

echo ""
echo "=== Frontend deploy complete ==="
