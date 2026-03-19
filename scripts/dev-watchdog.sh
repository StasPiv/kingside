#!/bin/bash
# Dev watchdog: перезапускает nest dev-сервер если он упал
# Запуск из cron: */2 * * * * bash /home/pivovartsev/work/kingside/scripts/dev-watchdog.sh

REPO_DIR="/home/pivovartsev/work/kingside"
LOG="/tmp/kingside-dev-watchdog.log"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

# Проверяем что dev-сервер должен быть запущен (turbo или nest)
# Если ранее запускался — перезапускаем при падении
if ! curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
    # Проверяем не запущен ли уже nest
    if pgrep -f "nest start" > /dev/null 2>&1; then
        exit 0  # nest запущен, просто ещё стартует
    fi
    echo "[$TS] API down — restarting nest dev..." >> "$LOG"
    cd "$REPO_DIR"
    npm run dev --workspace=@kingside/api >> "$LOG" 2>&1 &
    echo "[$TS] started PID=$!" >> "$LOG"
fi
