#!/bin/bash
# Cron-обёртка для сканирования chess-results.com (KS-714)
# Сканирует турниры за последние 30 дней
# Запуск: bash scripts/scan-chess-results-cron.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="/var/log/kingside-chess-results-scan.log"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

FROM=$(date -d "-30 days" '+%Y-%m-%d' 2>/dev/null || date -v-30d '+%Y-%m-%d')
TO=$(date '+%Y-%m-%d')

echo "[$TS] Starting chess-results scan: --from $FROM --to $TO" >> "$LOG"

docker compose -f "$REPO_DIR/docker-compose.yml" exec -T api \
    node dist/broadcast/chess-results/scan-chess-results.js --from "$FROM" --to "$TO" \
    >> "$LOG" 2>&1

echo "[$TS] Scan complete. exit=$?" >> "$LOG"
