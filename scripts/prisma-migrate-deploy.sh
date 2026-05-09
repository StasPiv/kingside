#!/usr/bin/env bash
# Накатывает все недостающие миграции на локальные БД через `prisma migrate deploy`.
# `migrate deploy` применяет только миграции, помеченные не-applied в _prisma_migrations,
# не делает diff и не требует reset (в отличие от `migrate dev`).
#
# Использование:
#   npm run prisma:migrate                # все три БД (если переменные заданы)
#   PRISMA_SCOPE=main npm run prisma:migrate     # только packages/db (kingside)
#   PRISMA_SCOPE=archive ...                     # только archive-db
#   PRISMA_SCOPE=broadcasts ...                  # только broadcasts-db
#
# Источник переменных — корневой /project/.env (читаем через set -a + source).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Подгружаем переменные из .env (если файл есть). Уже выставленные в окружении побеждают.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

SCOPE="${PRISMA_SCOPE:-all}"

prisma_invoke() {
  # $1 = url, $2 = schema (relative to ROOT), $3..n = prisma args
  local url="$1" schema="$2"
  shift 2
  ( cd apps/api && DATABASE_URL="$url" npx --no-install prisma "$@" --schema "../../$schema" )
}

run_migrate() {
  local label="$1" schema="$2" url_var="$3"
  local url="${!url_var:-}"

  if [[ -z "$url" ]]; then
    echo "[prisma:migrate] skip $label — переменная $url_var не задана"
    return 0
  fi
  if [[ ! -f "$schema" ]]; then
    echo "[prisma:migrate] skip $label — schema $schema не найдена"
    return 0
  fi

  echo "[prisma:migrate] $label → $schema"

  # `migrate deploy` иногда падает на дрейфе: миграция уже применена руками,
  # но не помечена в _prisma_migrations. Тогда P3018 + 42P07 (relation already exists)
  # или 42701 (column already exists). Парсим имя миграции из лога, помечаем applied и повторяем.
  local attempts=0
  local max_attempts=30
  local tmp
  tmp="$(mktemp)"
  while (( attempts < max_attempts )); do
    if prisma_invoke "$url" "$schema" migrate deploy >"$tmp" 2>&1; then
      cat "$tmp"
      rm -f "$tmp"
      return 0
    fi
    cat "$tmp"

    # P3018 + already exists → авто-resolve той миграции, что упала.
    local failed=""
    if grep -q "P3018" "$tmp" && grep -qE "(already exists|duplicate)" "$tmp"; then
      failed="$(awk '/Migration name:/ {print $3; exit}' "$tmp")"
    fi
    # P3009 — в _prisma_migrations есть ранее упавшая миграция (rollback не делался).
    # Имя в формате `The \`<name>\` migration started at ... failed`.
    if [[ -z "$failed" ]] && grep -q "P3009" "$tmp"; then
      failed="$(grep -oE "The \`[^\`]+\` migration started" "$tmp" | head -1 | sed -E "s/^The \`([^\`]+)\`.*/\1/")"
    fi
    if [[ -n "$failed" ]]; then
      echo "[prisma:migrate] drift/failed на $failed → resolve --applied"
      prisma_invoke "$url" "$schema" migrate resolve --applied "$failed" || {
        echo "[prisma:migrate] resolve $failed не удался"
        rm -f "$tmp"
        return 1
      }
      attempts=$((attempts + 1))
      continue
    fi

    rm -f "$tmp"
    return 1
  done

  echo "[prisma:migrate] превышено $max_attempts попыток drift-resolve"
  rm -f "$tmp"
  return 1
}

case "$SCOPE" in
  main)
    run_migrate "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL"
    ;;
  archive)
    run_migrate "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL"
    ;;
  broadcasts)
    run_migrate "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL"
    ;;
  all)
    run_migrate "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL"
    run_migrate "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL"
    run_migrate "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL"
    ;;
  *)
    echo "[prisma:migrate] неизвестный PRISMA_SCOPE='$SCOPE' (доступно: all|main|archive|broadcasts)" >&2
    exit 2
    ;;
esac

echo "[prisma:migrate] готово (scope=$SCOPE)"
