#!/bin/bash
# KS-1567: Зачистка остатков puzzle-worker в инфраструктуре.
#
# После KS-1564 код apps/puzzle-worker удалён из git, но остались хвосты:
#   - упоминание apps/puzzle-worker/ в .claude/agents/backend.md
#   - физическая папка apps/puzzle-worker/ на хосте (untracked файлы)
#   - записи @kingside/puzzle-worker в package-lock.json
#
# webhook-server.py НЕ трогаем — строку монтирования пользователь уберёт сам.
#
# Запускать на хосте из корня репо: bash scripts/cleanup-puzzle-worker-infra.sh
# Идемпотентный: повторный запуск безопасен.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "[cleanup] Repo: $REPO_DIR"

# 1. .claude/agents/backend.md — убрать apps/puzzle-worker/ из перечня rw-директорий
if [ -f .claude/agents/backend.md ]; then
    if grep -q "apps/puzzle-worker" .claude/agents/backend.md; then
        echo "[cleanup] .claude/agents/backend.md: удаляю упоминания puzzle-worker"
        sed -i 's|, `apps/puzzle-worker/`||g' .claude/agents/backend.md
        sed -i 's|`apps/puzzle-worker/`, ||g' .claude/agents/backend.md
        sed -i 's|`apps/puzzle-worker/`||g' .claude/agents/backend.md
    else
        echo "[cleanup] .claude/agents/backend.md: уже очищен"
    fi
else
    echo "[cleanup] .claude/agents/backend.md: не найден, пропускаю"
fi

# 2. apps/puzzle-worker/ — удалить физически
if [ -d apps/puzzle-worker ]; then
    echo "[cleanup] apps/puzzle-worker: удаляю физически"
    rm -rf apps/puzzle-worker
else
    echo "[cleanup] apps/puzzle-worker: уже удалён"
fi

# 3. package-lock.json — пересобрать через npm install
if grep -q "@kingside/puzzle-worker" package-lock.json 2>/dev/null; then
    echo "[cleanup] package-lock.json: содержит @kingside/puzzle-worker, запускаю npm install"
    npm install --no-audit --no-fund
else
    echo "[cleanup] package-lock.json: уже очищен"
fi

echo "[cleanup] Проверка результата:"
grep -c "puzzle-worker" .claude/agents/backend.md 2>/dev/null || echo "  backend.md: 0 совпадений"
grep -c "@kingside/puzzle-worker" package-lock.json 2>/dev/null || echo "  package-lock.json: 0 совпадений"
[ -d apps/puzzle-worker ] && echo "  apps/puzzle-worker: всё ещё существует" || echo "  apps/puzzle-worker: удалён"

echo "[cleanup] Готово"
