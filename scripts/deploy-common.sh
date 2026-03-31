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
        --exclude='.deploy-commit' \
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

# Get last deployed commit hash from server
get_deployed_commit() {
    ssh "$REMOTE_HOST" "cat $REMOTE_DIR/.deploy-commit 2>/dev/null" || echo ""
}

# Save current commit hash to server after successful deploy
save_deployed_commit() {
    local commit
    commit=$(git -C "$REPO_DIR" rev-parse HEAD)
    ssh "$REMOTE_HOST" "echo '$commit' > $REMOTE_DIR/.deploy-commit"
    echo "  Saved deploy commit: ${commit:0:7}"
}

# Detect deploy scope by comparing current HEAD with last deployed commit
# Returns: "frontend", "api", "all"
detect_deploy_scope() {
    local deployed_commit
    deployed_commit=$(get_deployed_commit)

    if [ -z "$deployed_commit" ]; then
        echo "all"
        return
    fi

    local current_commit
    current_commit=$(git -C "$REPO_DIR" rev-parse HEAD)

    if [ "$deployed_commit" = "$current_commit" ]; then
        echo "none"
        return
    fi

    # Check if deployed commit exists in history
    if ! git -C "$REPO_DIR" cat-file -t "$deployed_commit" &>/dev/null; then
        echo "all"
        return
    fi

    local changed_files
    changed_files=$(git -C "$REPO_DIR" diff --name-only "$deployed_commit"..HEAD)

    local has_frontend=false
    local has_api=false

    while IFS= read -r file; do
        [ -z "$file" ] && continue
        case "$file" in
            apps/web/*|packages/shared/*)
                has_frontend=true ;;
            apps/api/*|docker-compose.yml|Dockerfile|prisma/*|packages/shared/*)
                has_api=true ;;
            scripts/*|infra/*|justfile)
                # Infra changes — deploy all to be safe
                has_frontend=true
                has_api=true ;;
        esac
    done <<< "$changed_files"

    if $has_frontend && $has_api; then
        echo "all"
    elif $has_frontend; then
        echo "frontend"
    elif $has_api; then
        echo "api"
    else
        # Other files (docs, .claude, etc) — no deploy needed
        echo "none"
    fi
}
