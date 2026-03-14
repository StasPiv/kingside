#!/bin/bash
# Деплой Kingside напрямую с локальной машины на kamatera-chess
# Не требует push на GitHub — синхронизирует код через rsync
# Запуск: bash scripts/deploy-local.sh [--skip-frontend-build]
#
# Предполагает:
# - SSH доступ к kamatera-chess настроен (~/.ssh/config)
# - На сервере ~/kingside существует и .env настроен
# - domain и nginx уже настроены

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REMOTE_HOST="kamatera-chess"
REMOTE_DIR="~/kingside"
WEB_DIST="$REPO_DIR/apps/web/dist"
SKIP_FRONTEND_BUILD="${1:-}"

# Продакшен URL — используется при сборке frontend
PROD_API_URL="${VITE_API_URL:-https://chess-analyze.online}"

echo "=== Деплой Kingside (direct rsync) ==="
echo "Локальный репозиторий: $REPO_DIR"
echo "Сервер: $REMOTE_HOST:$REMOTE_DIR"
echo ""

# 1. Сборка frontend (локально)
if [ "$SKIP_FRONTEND_BUILD" != "--skip-frontend-build" ]; then
    echo "[1/5] Сборка frontend локально (VITE_API_URL=$PROD_API_URL)..."
    VITE_API_URL="$PROD_API_URL" npm run build --workspace=apps/web
    echo "  Frontend собран: $WEB_DIST"
else
    echo "[1/5] Сборка frontend пропущена (--skip-frontend-build)"
    if [ ! -d "$WEB_DIST" ]; then
        echo "ERROR: $WEB_DIST не найден. Запустите без --skip-frontend-build."
        exit 1
    fi
fi

# 2. Синхронизация исходников backend на сервер
echo "[2/5] Синхронизация кода на сервер..."
rsync -az --delete \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.worktrees' \
    --exclude='.claude' \
    --exclude='apps/web/dist' \
    --exclude='.env' \
    --exclude='*.log' \
    "$REPO_DIR/" "$REMOTE_HOST:$REMOTE_DIR/"
echo "  Код синхронизирован."

# 3. Деплой frontend статики на сервер
echo "[3/5] Деплой frontend статики..."
rsync -az --delete "$WEB_DIST/" "$REMOTE_HOST:/var/www/kingside/"
echo "  Frontend задеплоен в /var/www/kingside."

# 4. Пересборка и перезапуск API на сервере
echo "[4/5] Пересборка и перезапуск API на сервере..."
ssh "$REMOTE_HOST" "cd $REMOTE_DIR && \
    echo 'Очистка диска перед сборкой...' && \
    bash scripts/disk-cleanup.sh && \
    echo 'Сборка образа API...' && \
    docker compose build --no-cache api && \
    docker image prune -f && \
    echo 'Перезапуск контейнера API...' && \
    docker compose up -d --force-recreate api && \
    echo 'Ожидание готовности API (healthcheck)...' && \
    API_READY=0 && \
    for i in \$(seq 1 40); do \
        STATUS=\$(docker compose ps --format json api 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get(\"Health\",\"\"))' 2>/dev/null || echo ''); \
        if curl -sf http://localhost:3001/api/health &>/dev/null; then \
            echo 'API готов.'; \
            API_READY=1; \
            break; \
        fi; \
        sleep 3; \
    done && \
    if [ \"\$API_READY\" -eq 0 ]; then \
        echo 'ERROR: API не стартовал за 120 сек. Логи:'; \
        docker compose logs api --tail=50; \
        exit 1; \
    fi"

# 5. Перезагрузка nginx
echo "[5/5] Перезагрузка nginx..."
ssh "$REMOTE_HOST" "sudo nginx -t && sudo systemctl reload nginx"

echo ""
echo "=== Деплой завершён ==="
echo ""
echo "Проверка:"
echo "  ssh $REMOTE_HOST 'cd $REMOTE_DIR && bash scripts/server-check.sh'"
