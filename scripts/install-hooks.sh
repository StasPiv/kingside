#!/bin/bash
# Устанавливает git hooks (pre-commit, post-commit, post-merge)
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

install_pre_commit() {
    local hook_path="$GIT_HOOKS_DIR/pre-commit"
    local src="$SCRIPT_DIR/hooks/pre-commit"

    if [ ! -f "$src" ]; then
        echo "  WARN: $src не найден, пропускаем pre-commit"
        return
    fi

    if [ -f "$hook_path" ] && [ ! -L "$hook_path" ]; then
        echo "  WARN: pre-commit уже существует, создаём резервную копию: pre-commit.bak"
        cp "$hook_path" "${hook_path}.bak"
    fi

    ln -sf "$src" "$hook_path"
    chmod +x "$hook_path"
    echo "  Установлен: pre-commit -> $src"
}

echo "=== Установка git hooks ==="
install_pre_commit
install_hook "post-commit"
install_hook "post-merge"
echo ""
echo "Готово. Автодеплой отключён. Для деплоя используйте: just deploy"
