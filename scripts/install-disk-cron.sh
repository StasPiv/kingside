#!/bin/bash
# Установка cron-задачи для автоматической очистки диска (KS-515)
# Запуск на сервере: bash scripts/install-disk-cron.sh
#
# Устанавливает:
# - Ежедневную очистку Docker и worktrees в 3:00 ночи

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRON_JOB="0 3 * * * cd $REPO_DIR && bash scripts/disk-cleanup.sh >> /var/log/kingside-disk-cleanup.log 2>&1"

echo "=== Установка cron для очистки диска ==="
echo ""

# Проверить, не установлена ли уже задача
if crontab -l 2>/dev/null | grep -q "disk-cleanup.sh"; then
    echo "Cron-задача уже установлена:"
    crontab -l | grep "disk-cleanup.sh"
    echo ""
    echo "Для обновления — удалите старую запись вручную и запустите скрипт снова."
    exit 0
fi

# Добавить задачу
(crontab -l 2>/dev/null || true; echo "$CRON_JOB") | crontab -

echo "Cron-задача установлена:"
crontab -l | grep "disk-cleanup.sh"
echo ""
echo "Лог очистки: /var/log/kingside-disk-cleanup.log"
