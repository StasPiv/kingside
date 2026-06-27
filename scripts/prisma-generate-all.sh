#!/usr/bin/env bash
# Перегенерирует Prisma-клиентов для всех схем в монорепо.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Подкачка prisma engine-бинарников под openssl-3, если системный openssl 3.x,
# а в node_modules лежит только сборка под openssl-1.1.x. См. ensure-prisma-engines.sh.
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/ensure-prisma-engines.sh"
ensure_prisma_engines "$ROOT_DIR"

run_generate() {
  local label="$1" schema="$2"
  if [[ ! -f "$schema" ]]; then
    echo "[prisma:generate] skip $label — schema $schema не найдена"
    return 0
  fi
  echo "[prisma:generate] $label → $schema"
  ( cd apps/api && npx --no-install prisma generate --schema "../../$schema" )
}

run_generate "main (kingside)" "packages/db/prisma/schema.prisma"
run_generate "archive" "packages/archive-db/prisma/schema.prisma"
run_generate "broadcasts" "packages/broadcasts-db/prisma/schema.prisma"
run_generate "events" "packages/events-db/prisma/schema.prisma"

echo "[prisma:generate] готово"
