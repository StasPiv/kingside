#!/bin/bash
# Zero-downtime blue-green deploy for Kingside API
# Runs ON the server (called by deploy-local.sh via SSH)
#
# Flow:
# 1. Build new API image
# 2. Start api-green on port 3002 (new code)
# 3. Healthcheck on 3002
# 4. Switch nginx upstream to 3002
# 5. Recreate api on 3001 (new code) — safe, traffic on green
# 6. Healthcheck on 3001
# 7. Switch nginx upstream back to 3001
# 8. Stop api-green

set -euo pipefail

REPO_DIR="${1:-$(pwd)}"
cd "$REPO_DIR"

UPSTREAM_CONF="/etc/nginx/conf.d/kingside-upstream.conf"
HEALTHCHECK_TIMEOUT=40
HEALTHCHECK_INTERVAL=3

switch_upstream() {
    local port="$1"
    echo "upstream kingside_api { server 127.0.0.1:${port}; }" \
        | sudo tee "$UPSTREAM_CONF" > /dev/null
    sudo nginx -t && sudo systemctl reload nginx
    echo "  Nginx upstream -> 127.0.0.1:${port}"
}

wait_for_health() {
    local port="$1"
    local label="$2"
    echo "--- Waiting for ${label} healthcheck on port ${port}..."
    for i in $(seq 1 "$HEALTHCHECK_TIMEOUT"); do
        if curl -sf "http://localhost:${port}/api/health" &>/dev/null; then
            echo "  ${label} ready."
            return 0
        fi
        sleep "$HEALTHCHECK_INTERVAL"
    done
    echo "  ERROR: ${label} not ready after $((HEALTHCHECK_TIMEOUT * HEALTHCHECK_INTERVAL))s"
    return 1
}

# --- 1. Disk cleanup & space check ---
echo "--- Disk cleanup..."
bash scripts/disk-cleanup.sh

DISK_USED=$(df / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
DISK_FREE_H=$(df -h / | awk 'NR==2 {print $4}')
echo "  Disk: ${DISK_USED}% used, ${DISK_FREE_H} free"
if [ "$DISK_USED" -gt 80 ]; then
    echo "ERROR: Disk >80%. Deploy aborted — production untouched."
    exit 1
fi

# --- 2. Save rollback image ---
echo "--- Saving rollback image..."
COMPOSE_PROJECT=$(basename "$(pwd)")
OLD_IMAGE=$(docker images "${COMPOSE_PROJECT}-api:latest" --format '{{.ID}}' | head -1)
if [ -n "$OLD_IMAGE" ]; then
    docker tag "${COMPOSE_PROJECT}-api:latest" "${COMPOSE_PROJECT}-api:pre-deploy"
    echo "  Rollback image saved: $OLD_IMAGE"
else
    echo "  No previous image found, rollback unavailable."
fi

# --- 3. Build new API image ---
echo "--- Building new API image..."
docker compose build --no-cache api
docker image prune -f

# --- 4. Start api-green on port 3002 ---
echo "--- Starting api-green on port 3002..."
docker compose --profile deploy up -d api-green

# --- 5. Healthcheck on green ---
if ! wait_for_health 3002 "api-green"; then
    echo "ERROR: api-green failed. Cleaning up — production untouched."
    docker compose --profile deploy stop api-green 2>/dev/null || true
    docker compose --profile deploy rm -f api-green 2>/dev/null || true
    # Rollback image
    if docker images "${COMPOSE_PROJECT}-api:pre-deploy" --format '{{.ID}}' | grep -q .; then
        docker tag "${COMPOSE_PROJECT}-api:pre-deploy" "${COMPOSE_PROJECT}-api:latest"
    fi
    exit 1
fi

# --- 6. Switch nginx to green (3002) ---
echo "--- Switching traffic to api-green (3002)..."
switch_upstream 3002

# --- 7. Recreate api (blue) on 3001 --- traffic is safe on green
echo "--- Recreating api on port 3001..."
docker compose up -d --force-recreate --no-build api

# --- 8. Healthcheck on blue ---
if ! wait_for_health 3001 "api"; then
    echo "WARN: api on 3001 not ready. Keeping traffic on api-green (3002)."
    echo "  api-green will keep running. Manual intervention needed."
    exit 0
fi

# --- 9. Switch nginx back to blue (3001) ---
echo "--- Switching traffic back to api (3001)..."
switch_upstream 3001

# --- 10. Stop green ---
echo "--- Stopping api-green..."
docker compose --profile deploy stop api-green 2>/dev/null || true
docker compose --profile deploy rm -f api-green 2>/dev/null || true

echo "--- Zero-downtime deploy complete."
