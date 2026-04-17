#!/bin/bash
# preinstall-хук: блокирует `npm install` внутри git worktree.
#
# Причина: npm install из worktree может затереть workspace symlinks
# в корневом node_modules основной рабочей копии (npm workspaces + Turbo
# используют общие symlinks для packages/*). В результате — сломанный
# dev-режим и нерабочий `just up` в основной копии.
#
# Правила:
#   - Если текущая директория — worktree (git-dir != git-common-dir),
#     установка блокируется с понятным сообщением.
#   - Если основная рабочая копия — пропускаем, установка продолжается.
#   - Вне git-репо (например, установка из tarball, CI без .git) — пропускаем.
#   - Принудительный обход: SKIP_WORKTREE_CHECK=1 npm install.

set -euo pipefail

# Явный обход (для отладки и edge-cases).
if [ "${SKIP_WORKTREE_CHECK:-0}" = "1" ]; then
    exit 0
fi

# Если git не установлен — пропускаем, чтобы не ломать install в чистых
# окружениях (docker-билды без git).
if ! command -v git >/dev/null 2>&1; then
    exit 0
fi

GIT_DIR="$(git rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"

# Не git-репо — пропускаем.
if [ -z "$GIT_DIR" ] || [ -z "$GIT_COMMON_DIR" ]; then
    exit 0
fi

# В worktree git-dir отличается от git-common-dir
# (git-dir = .git/worktrees/<name>, git-common-dir = .git основной копии).
if [ "$GIT_DIR" != "$GIT_COMMON_DIR" ]; then
    echo "" >&2
    echo "✋ npm install заблокирован: вы внутри git worktree." >&2
    echo "" >&2
    echo "  git-dir        : $GIT_DIR" >&2
    echo "  git-common-dir : $GIT_COMMON_DIR" >&2
    echo "" >&2
    echo "Зависимости устанавливайте только в основной рабочей копии:" >&2
    echo "общий node_modules делится через workspace symlinks, и установка" >&2
    echo "из worktree может их сломать." >&2
    echo "" >&2
    echo "Подготовка worktree без npm install:" >&2
    echo "  bash scripts/setup-worktree.sh" >&2
    echo "" >&2
    echo "Принудительный запуск (на свой риск):" >&2
    echo "  SKIP_WORKTREE_CHECK=1 npm install" >&2
    echo "" >&2
    exit 1
fi

exit 0
