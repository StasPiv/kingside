#!/bin/bash
# Подготовка worktree после создания: генерация Prisma Client и сборка shared
# Запуск: bash scripts/setup-worktree.sh [worktree_path]
# Если worktree_path не указан — используется текущая директория

set -euo pipefail

WORKTREE_DIR="${1:-.}"
WORKTREE_DIR="$(cd "$WORKTREE_DIR" && pwd)"

echo "=== Setup worktree: $WORKTREE_DIR ==="

# 1. Генерация Prisma Client
SCHEMA="$WORKTREE_DIR/apps/api/prisma/schema.prisma"
PRISMA_OUT="$WORKTREE_DIR/apps/api/src/generated/prisma"

if [ ! -f "$SCHEMA" ]; then
    echo "ERROR: schema.prisma не найден: $SCHEMA"
    exit 1
fi

echo "  Генерация Prisma Client..."
npx prisma generate --schema="$SCHEMA"
echo "  Prisma Client сгенерирован: $PRISMA_OUT"

# 2. Сборка packages/shared
SHARED_DIR="$WORKTREE_DIR/packages/shared"
SHARED_DIST="$SHARED_DIR/dist"

if [ ! -d "$SHARED_DIR/src" ]; then
    echo "ERROR: packages/shared/src не найден: $SHARED_DIR/src"
    exit 1
fi

echo "  Сборка packages/shared..."
npx tsc --build "$SHARED_DIR" --force
echo "  packages/shared собран: $SHARED_DIST"

echo ""
echo "=== Worktree готов к работе ==="
