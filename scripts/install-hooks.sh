#!/bin/bash
# Устанавливает git hooks для автодеплоя на kamatera-chess при коммите в main
# Запуск: bash scripts/install-hooks.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GIT_HOOKS_DIR="$REPO_DIR/.git/hooks"
HOOK_SRC="$SCRIPT_DIR/hooks/post-deploy-hook"

if [ ! -d "$GIT_HOOKS_DIR" ]; then
    echo "ERROR: $GIT_HOOKS_DIR не найден. Запустите из корня репозитория."
    exit 1
fi

install_hook() {
    local hook_name="$1"
    local hook_path="$GIT_HOOKS_DIR/$hook_name"

    if [ -f "$hook_path" ] && [ ! -L "$hook_path" ]; then
        echo "  WARN: $hook_name уже существует, создаём резервную копию: ${hook_name}.bak"
        cp "$hook_path" "${hook_path}.bak"
    fi

    ln -sf "$HOOK_SRC" "$hook_path"
    chmod +x "$hook_path"
    echo "  Установлен: $hook_name -> $HOOK_SRC"
}

echo "=== Установка git hooks для автодеплоя ==="
install_hook "post-commit"
install_hook "post-merge"
echo ""
echo "Готово. Каждый коммит/мерж в ветку main будет запускать деплой на kamatera-chess."
