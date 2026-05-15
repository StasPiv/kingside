#!/bin/sh
set -e

# KS-3050 (ADR-045 E3): миграции применяет pre-rollout `aws ecs run-task`
# из scripts/deploy-aws.sh ДО того, как новая ECS task стартует. Повтор
# `prisma migrate deploy` здесь — race-condition при параллельном
# rolling-update (две task'и пытаются мигрировать одновременно) плюс
# лишние 1–3 секунды на cold-start каждого контейнера.
#
# Оставлен escape-hatch: `RUN_MIGRATE_ON_START=true` вернёт прежнее
# поведение (локальный dev / экстренный deploy без run-task). По
# умолчанию выключено — прод полагается на pre-rollout.
#
# Историческая заметка (KS-2216): миграции на старте появились, когда
# pre-rollout ещё не было; сейчас оба источника избыточны.
if [ "${RUN_MIGRATE_ON_START:-false}" = "true" ]; then
  echo "[entrypoint] RUN_MIGRATE_ON_START=true — applying Prisma migrations..."
  npx prisma migrate deploy
fi

echo "[entrypoint] Starting API..."
exec node dist/main.js
