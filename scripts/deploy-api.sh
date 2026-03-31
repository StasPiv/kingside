#!/bin/bash
# Deploy only API (Docker build + blue-green zero-downtime)
# Usage: bash scripts/deploy-api.sh

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-common.sh"

fix_symlinks

echo "=== API Deploy (blue-green) ==="
echo ""

# 1. Sync code to server
echo "[1/4] Syncing code to server..."
sync_code

# 2. Setup nginx
echo "[2/4] Setting up nginx..."
setup_nginx

# 3. Zero-downtime blue-green deploy
echo "[3/4] Running zero-downtime deploy..."
ssh "$REMOTE_HOST" "cd $REMOTE_DIR && bash scripts/deploy-server-zero-downtime.sh"

# 4. Check cron jobs
echo "[4/4] Checking cron jobs..."
check_cron

echo ""
echo "=== API deploy complete ==="
