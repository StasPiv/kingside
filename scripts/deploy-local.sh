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

# Загружаем VITE_* переменные из локального .env (VITE_DEV_BYPASS_SECRET и др.)
# VITE_API_URL намеренно переопределяется ниже через PROD_API_URL
if [ -f "$REPO_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$REPO_DIR/.env"
    set +a
fi

# Fix circular symlinks in node_modules (created by worktree agents)
for d in apps/web/node_modules apps/api/node_modules; do
    if [ -L "$REPO_DIR/$d" ] && [ "$(readlink "$REPO_DIR/$d")" = "$REPO_DIR/$d" ]; then
        echo "[pre-deploy] Удалён circular symlink: $d"
        rm "$REPO_DIR/$d"
    fi
done
# Ensure node_modules are installed
if [ ! -d "$REPO_DIR/node_modules/vite" ]; then
    echo "[pre-deploy] node_modules отсутствуют — npm install..."
    npm install --prefix "$REPO_DIR" 2>&1 | tail -3
fi

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
ssh "$REMOTE_HOST" "set -e && cd $REMOTE_DIR && \
    \
    echo '--- Очистка диска перед сборкой...' && \
    bash scripts/disk-cleanup.sh && \
    \
    echo '--- Проверка свободного места...' && \
    DISK_USED=\$(df / | awk 'NR==2 {gsub(/%/,\"\",\$5); print \$5}') && \
    DISK_FREE_H=\$(df -h / | awk 'NR==2 {print \$4}') && \
    echo \"  Использовано: \${DISK_USED}%, свободно: \${DISK_FREE_H}\" && \
    if [ \"\$DISK_USED\" -gt 80 ]; then \
        echo \"ERROR: Диск заполнен на \${DISK_USED}% (>80%). Деплой прерван — продакшен не затронут.\"; \
        exit 1; \
    fi && \
    \
    echo '--- Сохранение текущего образа для отката...' && \
    COMPOSE_PROJECT=\$(basename \$(pwd)) && \
    OLD_IMAGE=\$(docker images \${COMPOSE_PROJECT}-api:latest --format '{{.ID}}' | head -1) && \
    if [ -n \"\$OLD_IMAGE\" ]; then \
        docker tag \${COMPOSE_PROJECT}-api:latest \${COMPOSE_PROJECT}-api:pre-deploy; \
        echo \"  Образ для отката сохранён: \$OLD_IMAGE\"; \
    else \
        echo '  Предыдущий образ не найден, откат будет недоступен.'; \
    fi && \
    \
    echo '--- Сборка образа API...' && \
    docker compose build --no-cache api && \
    docker image prune -f && \
    \
    echo '--- Перезапуск контейнера API...' && \
    docker compose up -d --force-recreate api && \
    \
    echo '--- Ожидание готовности API (healthcheck)...' && \
    API_READY=0 && \
    for i in \$(seq 1 40); do \
        if curl -sf http://localhost:3001/api/health &>/dev/null; then \
            echo 'API готов.'; \
            API_READY=1; \
            break; \
        fi; \
        sleep 3; \
    done && \
    if [ \"\$API_READY\" -eq 0 ]; then \
        echo 'ERROR: API не стартовал за 120 сек. Выполняю автоматический откат...'; \
        docker compose logs api --tail=50; \
        if docker images \${COMPOSE_PROJECT}-api:pre-deploy --format '{{.ID}}' | grep -q .; then \
            docker compose stop api || true; \
            docker tag \${COMPOSE_PROJECT}-api:pre-deploy \${COMPOSE_PROJECT}-api:latest; \
            docker compose up -d --no-build api; \
            sleep 10; \
            if curl -sf http://localhost:3001/api/health &>/dev/null; then \
                echo 'Откат выполнен успешно. API работает на предыдущем образе.'; \
            else \
                echo 'ERROR: Откат завершён, но API всё равно не отвечает. Требуется ручное вмешательство.'; \
            fi; \
        else \
            echo 'ERROR: Образ для отката не найден. Требуется ручное вмешательство.'; \
        fi; \
        exit 1; \
    fi"

# 5. Перезагрузка nginx
echo "[5/5] Перезагрузка nginx..."
ssh "$REMOTE_HOST" "sudo nginx -t && sudo systemctl reload nginx"

# 6. Убедиться, что cron-задания установлены
echo "[6/6] Проверка cron-заданий на сервере..."
ssh "$REMOTE_HOST" "cd $REMOTE_DIR && bash scripts/install-disk-cron.sh"

echo ""
echo "=== Деплой завершён ==="
echo ""
echo "Проверка:"
echo "  ssh $REMOTE_HOST 'cd $REMOTE_DIR && bash scripts/server-check.sh'"
