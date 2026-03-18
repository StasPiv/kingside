#!/bin/bash
# Watchdog для kingside (KS-519, KS-682)
# Проверяет: API контейнер запущен, Redis writable (не slave).
# Запускается из cron каждые 5 минут.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="/var/log/kingside-api-watchdog.log"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

# 1. Проверка API контейнера
STATUS=$(docker inspect --format '{{.State.Status}}' kingside-api-1 2>/dev/null || echo "missing")

if [ "$STATUS" != "running" ]; then
    echo "[$TS] kingside-api status='$STATUS' — starting..." >> "$LOG"
    cd "$REPO_DIR"
    docker compose up -d api >> "$LOG" 2>&1
    echo "[$TS] api restart done. exit=$?" >> "$LOG"
fi

# 2. Проверка Redis: writable (не slave/readonly)
REDIS_PORT="${REDIS_PORT:-6380}"
REDIS_WRITE=$(redis-cli -p "$REDIS_PORT" SET _watchdog_check 1 EX 30 2>&1)
if echo "$REDIS_WRITE" | grep -qi "READONLY\|slave"; then
    echo "[$TS] ALERT: Redis is READONLY/slave! Fixing with REPLICAOF NO ONE..." >> "$LOG"
    redis-cli -p "$REDIS_PORT" REPLICAOF NO ONE >> "$LOG" 2>&1
    echo "[$TS] Redis fix done. exit=$?" >> "$LOG"
elif ! echo "$REDIS_WRITE" | grep -q "OK"; then
    echo "[$TS] WARN: Redis write check failed: $REDIS_WRITE" >> "$LOG"
fi
