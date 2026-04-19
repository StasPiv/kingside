#!/bin/bash
# KS-1567: Зачистка остатков puzzle-worker/puzzle-generator в инфраструктуре.
#
# После KS-1564 код apps/puzzle-worker и apps/api/src/puzzle-generator удалён,
# но в инфре остались хвосты:
#   - монтирование apps/puzzle-worker в webhook-server.py
#   - упоминание apps/puzzle-worker/ в .claude/agents/backend.md
#   - физическая папка apps/puzzle-worker/ на хосте (untracked файлы)
#   - записи @kingside/puzzle-worker в package-lock.json
#
# Запускать на хосте из корня репо: bash scripts/cleanup-puzzle-worker-infra.sh
# Идемпотентный: повторный запуск безопасен.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "[cleanup] Repo: $REPO_DIR"

# 1. webhook-server.py — убрать строку монтирования puzzle-worker
if [ -f webhook-server.py ]; then
    if grep -q "apps/puzzle-worker" webhook-server.py; then
        echo "[cleanup] webhook-server.py: удаляю строки с puzzle-worker"
        sed -i '/apps\/puzzle-worker/d' webhook-server.py
    else
        echo "[cleanup] webhook-server.py: уже очищен"
    fi
else
    echo "[cleanup] webhook-server.py: не найден, пропускаю"
fi

# 2. .claude/agents/backend.md — убрать apps/puzzle-worker/ из перечня rw-директорий
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

# 3. apps/puzzle-worker/ — удалить физически
if [ -d apps/puzzle-worker ]; then
    echo "[cleanup] apps/puzzle-worker: удаляю физически"
    rm -rf apps/puzzle-worker
else
    echo "[cleanup] apps/puzzle-worker: уже удалён"
fi

# 4. package-lock.json — пересобрать через npm install
if grep -q "@kingside/puzzle-worker" package-lock.json 2>/dev/null; then
    echo "[cleanup] package-lock.json: содержит @kingside/puzzle-worker, запускаю npm install"
    npm install --no-audit --no-fund
else
    echo "[cleanup] package-lock.json: уже очищен"
fi

echo "[cleanup] Проверка результата:"
grep -c "puzzle-worker" webhook-server.py 2>/dev/null || echo "  webhook-server.py: 0 совпадений"
grep -c "puzzle-worker" .claude/agents/backend.md 2>/dev/null || echo "  backend.md: 0 совпадений"
grep -c "@kingside/puzzle-worker" package-lock.json 2>/dev/null || echo "  package-lock.json: 0 совпадений"
[ -d apps/puzzle-worker ] && echo "  apps/puzzle-worker: всё ещё существует" || echo "  apps/puzzle-worker: удалён"

echo "[cleanup] Готово"
