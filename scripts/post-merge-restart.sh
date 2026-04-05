#!/bin/bash
# Перезапуск dev-серверов после merge из worktree
# Вызывается автоматически из post-merge hook (non-fast-forward)
# или вручную/через агентов после fast-forward merge
#
# Usage: bash scripts/post-merge-restart.sh

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Touch API main.ts — NestJS --watch перезапустится
if [ -f "$REPO_DIR/apps/api/src/main.ts" ]; then
    touch "$REPO_DIR/apps/api/src/main.ts"
    echo "[post-merge] touch apps/api/src/main.ts — NestJS перезапустится"
fi

# Touch Web main.tsx — Vite HMR перезагрузит
if [ -f "$REPO_DIR/apps/web/src/main.tsx" ]; then
    touch "$REPO_DIR/apps/web/src/main.tsx"
    echo "[post-merge] touch apps/web/src/main.tsx — Vite HMR перезагрузит"
fi

# Prisma generate если схема изменилась
if git diff --name-only HEAD~1 HEAD 2>/dev/null | grep -q "apps/api/prisma/"; then
    echo "[post-merge] prisma schema changed — generate + migrate..."
    cd "$REPO_DIR/apps/api"
    npx prisma generate 2>/dev/null && echo "[post-merge] prisma generate OK" || echo "[post-merge] WARN: prisma generate failed"
    npx prisma migrate deploy 2>/dev/null && echo "[post-merge] prisma migrate OK" || echo "[post-merge] WARN: prisma migrate failed"
fi
