#!/bin/bash
# Устанавливает git hooks (post-commit, post-merge)
# Автодеплой отключён. Деплой запускается вручную: just deploy
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

echo "=== Установка git hooks ==="
install_hook "post-commit"
install_hook "post-merge"
echo ""
echo "Готово. Автодеплой отключён. Для деплоя используйте: just deploy"
