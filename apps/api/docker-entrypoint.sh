#!/bin/sh
set -e

# KS-2216: применяем pending-миграции до старта API.
# prisma.config.ts указывает на ../../packages/db/prisma/schema.prisma и migrations.
echo "[entrypoint] Applying Prisma migrations..."
npx prisma migrate deploy

echo "[entrypoint] Starting API..."
exec node dist/main.js
