#!/bin/bash
# Установка cron-задач для Kingside (KS-515, KS-519)
# Запуск на сервере: bash scripts/install-disk-cron.sh
#
# Устанавливает:
# - Ежедневную очистку Docker и worktrees в 3:00 ночи
# - Watchdog API контейнера каждые 5 минут

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRON_CLEANUP="0 3 * * * cd $REPO_DIR && bash scripts/disk-cleanup.sh >> /var/log/kingside-disk-cleanup.log 2>&1"
CRON_WATCHDOG="*/5 * * * * bash $REPO_DIR/scripts/api-watchdog.sh"

echo "=== Установка cron-задач Kingside ==="
echo ""

CURRENT_CRON=$(crontab -l 2>/dev/null || true)
NEW_CRON="$CURRENT_CRON"
CHANGED=0

# disk-cleanup
if echo "$CURRENT_CRON" | grep -q "disk-cleanup.sh"; then
    echo "[disk-cleanup] уже установлен:"
    echo "$CURRENT_CRON" | grep "disk-cleanup.sh"
else
    NEW_CRON="${NEW_CRON}
${CRON_CLEANUP}"
    echo "[disk-cleanup] добавлен: $CRON_CLEANUP"
    CHANGED=1
fi

# api-watchdog
if echo "$CURRENT_CRON" | grep -q "api-watchdog.sh"; then
    echo "[api-watchdog] уже установлен:"
    echo "$CURRENT_CRON" | grep "api-watchdog.sh"
else
    NEW_CRON="${NEW_CRON}
${CRON_WATCHDOG}"
    echo "[api-watchdog] добавлен: $CRON_WATCHDOG"
    CHANGED=1
fi

if [ "$CHANGED" -eq 1 ]; then
    echo "$NEW_CRON" | crontab -
    echo ""
    echo "=== Итог crontab ==="
    crontab -l
fi

echo ""
echo "Лог очистки:  /var/log/kingside-disk-cleanup.log"
echo "Лог watchdog: /var/log/kingside-api-watchdog.log"
