#!/bin/bash
# Dev watchdog: перезапускает nest и vite dev-серверы если они упали
# Запуск из cron: */2 * * * * bash /home/pivovartsev/work/kingside/scripts/dev-watchdog.sh

REPO_DIR="/home/pivovartsev/work/kingside"
LOG="/tmp/kingside-dev-watchdog.log"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

# 1. Backend (nest)
if ! curl -sf http://localhost:3001/health > /dev/null 2>&1; then
    if pgrep -f "nest start" > /dev/null 2>&1; then
        exit 0  # nest запущен, просто ещё стартует
    fi
    echo "[$TS] API down — restarting nest dev..." >> "$LOG"
    cd "$REPO_DIR"
    CHOKIDAR_USEPOLLING=1 npm run dev --workspace=@kingside/api >> "$LOG" 2>&1 &
    echo "[$TS] nest started PID=$!" >> "$LOG"
fi

# 2. Frontend (vite) — CHOKIDAR_USEPOLLING для обхода ENOSPC inotify
if ! curl -sf http://localhost:5173 > /dev/null 2>&1; then
    if pgrep -f "vite" > /dev/null 2>&1; then
        exit 0  # vite запущен, ещё стартует
    fi
    echo "[$TS] Vite down — restarting..." >> "$LOG"
    cd "$REPO_DIR"
    CHOKIDAR_USEPOLLING=1 npm run dev --workspace=@kingside/web >> "$LOG" 2>&1 &
    echo "[$TS] vite started PID=$!" >> "$LOG"
fi
