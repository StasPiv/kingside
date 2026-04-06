#!/bin/bash
# Перезапуск dev-серверов после merge из worktree
# Вызывается автоматически из post-merge hook (non-fast-forward)
# или вручную/через агентов после fast-forward merge
#
# Делает полный nest build (watch mode не пересобирает все файлы)
# и touch main.ts/main.tsx для перезапуска watch процессов.
#
# ВАЖНО: НЕ использовать npx/npm — они ломают workspace symlinks.
#
# Usage: bash scripts/post-merge-restart.sh

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEST_CLI="$REPO_DIR/node_modules/@nestjs/cli/bin/nest.js"
PRISMA_CLI="$REPO_DIR/node_modules/prisma/build/index.js"
LOAD_BOTS_DIR="$REPO_DIR/load-bots"
LOAD_BOTS_TSC="$LOAD_BOTS_DIR/node_modules/typescript/bin/tsc"

# Полный nest build — watch mode не подхватывает новые/удалённые файлы
if [ -f "$NEST_CLI" ]; then
    echo "[post-merge] nest build..."
    cd "$REPO_DIR/apps/api"
    node "$NEST_CLI" build --path tsconfig.json 2>/dev/null && \
        echo "[post-merge] nest build OK" || \
        echo "[post-merge] WARN: nest build failed"
    cd "$REPO_DIR"
else
    echo "[post-merge] WARN: nest CLI not found at $NEST_CLI"
fi

# Touch API main.ts — NestJS --watch перезапустится с новым dist
if [ -f "$REPO_DIR/apps/api/src/main.ts" ]; then
    touch "$REPO_DIR/apps/api/src/main.ts"
    echo "[post-merge] touch apps/api/src/main.ts — NestJS перезапустится"
fi

# Touch Web main.tsx — Vite HMR перезагрузит
if [ -f "$REPO_DIR/apps/web/src/main.tsx" ]; then
    touch "$REPO_DIR/apps/web/src/main.tsx"
    echo "[post-merge] touch apps/web/src/main.tsx — Vite HMR перезагрузит"
fi

# Пересборка load-bots
if [ -f "$LOAD_BOTS_TSC" ] && [ -d "$LOAD_BOTS_DIR/src" ]; then
    echo "[post-merge] load-bots tsc..."
    cd "$LOAD_BOTS_DIR"
    node "$LOAD_BOTS_TSC" 2>/dev/null && \
        echo "[post-merge] load-bots build OK" || \
        echo "[post-merge] WARN: load-bots build failed"
    cd "$REPO_DIR"
fi

# Prisma generate если схема изменилась
if git diff --name-only HEAD~1 HEAD 2>/dev/null | grep -q "apps/api/prisma/"; then
    echo "[post-merge] prisma schema changed — generate + migrate..."
    cd "$REPO_DIR/apps/api"
    if [ -f "$PRISMA_CLI" ]; then
        node "$PRISMA_CLI" generate 2>/dev/null && \
            echo "[post-merge] prisma generate OK" || \
            echo "[post-merge] WARN: prisma generate failed"
        node "$PRISMA_CLI" migrate deploy 2>/dev/null && \
            echo "[post-merge] prisma migrate OK" || \
            echo "[post-merge] WARN: prisma migrate failed"
    else
        echo "[post-merge] WARN: prisma CLI not found"
    fi
fi
