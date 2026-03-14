#!/bin/bash
# Watchdog для kingside-api (KS-519)
# Проверяет, что контейнер запущен (status=running).
# Если нет — поднимает. Запускается из cron каждые 5 минут.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="/var/log/kingside-api-watchdog.log"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

STATUS=$(docker inspect --format '{{.State.Status}}' kingside-api-1 2>/dev/null || echo "missing")

if [ "$STATUS" = "running" ]; then
    exit 0
fi

echo "[$TS] kingside-api status='$STATUS' — starting..." >> "$LOG"
cd "$REPO_DIR"
docker compose up -d api >> "$LOG" 2>&1
echo "[$TS] done. exit=$?" >> "$LOG"
