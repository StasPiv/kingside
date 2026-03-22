#!/bin/sh
set -e

echo "=== Resolving failed Prisma migrations ==="
# Find and auto-resolve any failed migrations (finished_at IS NULL and NOT rolled back)
FAILED=$(npx prisma migrate status 2>&1 | grep -oP '(?<=Migration )\S+(?= failed)' || true)
for m in $FAILED; do
  echo "Resolving failed migration: $m"
  npx prisma migrate resolve --applied "$m" 2>&1 || true
done

echo "=== Running Prisma migrations ==="
npx prisma migrate deploy

echo "=== Starting API ==="
exec node dist/main.js
