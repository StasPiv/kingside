#!/bin/bash
# Общие переменные и функции для деплой-скриптов Kingside
# Не запускается напрямую — подключается через source

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REMOTE_HOST="kamatera-chess"
REMOTE_DIR="~/kingside"
WEB_DIST="$REPO_DIR/apps/web/dist"

# Продакшен URL — используется при сборке frontend
PROD_API_URL="${VITE_API_URL:-https://chess-analyze.online}"

# Загружаем VITE_* переменные из локального .env
if [ -f "$REPO_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$REPO_DIR/.env"
    set +a
fi

# Fix circular symlinks in node_modules (created by worktree agents)
fix_symlinks() {
    for d in apps/web/node_modules apps/api/node_modules; do
        if [ -L "$REPO_DIR/$d" ] && [ "$(readlink "$REPO_DIR/$d")" = "$REPO_DIR/$d" ]; then
            echo "[pre-deploy] Removed circular symlink: $d"
            rm "$REPO_DIR/$d"
        fi
    done
}

# Ensure node_modules are installed
ensure_deps() {
    if [ ! -d "$REPO_DIR/node_modules/vite" ]; then
        echo "[pre-deploy] node_modules missing — npm install..."
        npm install --prefix "$REPO_DIR" 2>&1 | tail -3
    fi
}

# Sync source code to server (excludes dist and .env)
sync_code() {
    echo "--- Syncing code to server..."
    rsync -az --delete \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='.worktrees' \
        --exclude='.claude' \
        --exclude='apps/web/dist' \
        --exclude='.env' \
        --exclude='*.log' \
        "$REPO_DIR/" "$REMOTE_HOST:$REMOTE_DIR/"
    echo "  Code synced."
}

# Setup nginx configs on server
setup_nginx() {
    echo "--- Setting up nginx..."
    ssh "$REMOTE_HOST" "
        sudo cp $REMOTE_DIR/infra/nginx/kingside.conf /etc/nginx/sites-available/kingside
        if [ ! -f /etc/nginx/conf.d/kingside-upstream.conf ]; then
            sudo cp $REMOTE_DIR/infra/nginx/kingside-upstream.conf /etc/nginx/conf.d/kingside-upstream.conf
            echo '  Upstream config created.'
        fi
        sudo nginx -t && sudo systemctl reload nginx
        echo '  Nginx config updated.'
    "
}

# Check cron jobs on server
check_cron() {
    echo "--- Checking cron jobs..."
    ssh "$REMOTE_HOST" "cd $REMOTE_DIR && bash scripts/install-disk-cron.sh"
}
