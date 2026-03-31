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

# 4. Setup nginx upstream config (first-time and updates)
echo "[4/6] Настройка nginx..."
ssh "$REMOTE_HOST" "
    sudo cp $REMOTE_DIR/infra/nginx/kingside.conf /etc/nginx/sites-available/kingside
    if [ ! -f /etc/nginx/conf.d/kingside-upstream.conf ]; then
        sudo cp $REMOTE_DIR/infra/nginx/kingside-upstream.conf /etc/nginx/conf.d/kingside-upstream.conf
        echo '  Upstream config created.'
    fi
    sudo nginx -t && sudo systemctl reload nginx
    echo '  Nginx config updated.'
"

# 5. Zero-downtime blue-green deploy
echo "[5/6] Zero-downtime deploy API (blue-green)..."
ssh "$REMOTE_HOST" "cd $REMOTE_DIR && bash scripts/deploy-server-zero-downtime.sh"

# 6. Убедиться, что cron-задания установлены
echo "[6/6] Проверка cron-заданий на сервере..."
ssh "$REMOTE_HOST" "cd $REMOTE_DIR && bash scripts/install-disk-cron.sh"

echo ""
echo "=== Деплой завершён ==="
echo ""
echo "Проверка:"
echo "  ssh $REMOTE_HOST 'cd $REMOTE_DIR && bash scripts/server-check.sh'"
