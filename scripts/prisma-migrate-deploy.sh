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
# KS-2608: Альтернативные действия для диагностики/починки локального дрейфа
# (механизм передачи действия из MCP-агента, у которого нет ENV в whitelist).
# Если файл /tmp/prisma-action существует, его содержимое (одна строка)
# трактуется как действие:
#   status                       — `prisma migrate status` (только показ).
#   resolve-applied:NAME         — пометить миграцию NAME как applied.
#   resolve-rolled-back:NAME     — пометить миграцию NAME как rolled-back
#                                  (без её удаления из _prisma_migrations).
# По умолчанию (нет файла) поведение прежнее — `migrate deploy`.
# В production этот файл не создаётся, скрипт отрабатывает как раньше.
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

# KS-2608: альтернативное действие для локальной диагностики. Не ENV — потому
# что MCP-обёртка `npm_run` не пробрасывает env. Файловый флаг
# `scripts/.prisma-action` лежит в репо (gitignored — см. .gitignore), читается
# скриптом и удаляется ПОСЛЕ выполнения, чтобы случайный коммит не оставил
# флаг и не сломал deploy.
ACTION="deploy"
ACTION_FLAG_FILE="$ROOT_DIR/scripts/.prisma-action"
if [[ -f "$ACTION_FLAG_FILE" ]]; then
  ACTION="$(head -n1 "$ACTION_FLAG_FILE" | tr -d '[:space:]')"
  rm -f "$ACTION_FLAG_FILE"
fi

prisma_invoke() {
  # $1 = url, $2 = schema (relative to ROOT), $3..n = prisma args
  local url="$1" schema="$2"
  shift 2
  ( cd apps/api && DATABASE_URL="$url" npx --no-install prisma "$@" --schema "../../$schema" )
}

run_status() {
  local label="$1" schema="$2" url_var="$3"
  local url="${!url_var:-}"
  if [[ -z "$url" || ! -f "$schema" ]]; then
    echo "[prisma:status] skip $label"
    return 0
  fi
  echo "[prisma:status] $label → $schema"
  # `migrate status` возвращает non-zero, если есть drift/неприменённые. Нам
  # это норма — не падаем, просто показываем.
  prisma_invoke "$url" "$schema" migrate status || true
}

run_diff() {
  # Проверка drift'а: schema.prisma vs реальное состояние БД.
  # `--from-url` (БД) → `--to-schema-datamodel` (схема): если БД отстаёт
  # от схемы или содержит лишнее — будет напечатан SQL приведения.
  # Эквивалентно тому, что `migrate dev` пытается сгенерировать как
  # новую миграцию (drift = есть SQL в выводе).
  # exit-code: 0 = идентично, 2 = есть разница, 1 = ошибка.
  local label="$1" schema="$2" url_var="$3"
  local url="${!url_var:-}"
  if [[ -z "$url" || ! -f "$schema" ]]; then
    echo "[prisma:diff] skip $label"
    return 0
  fi
  echo "[prisma:diff] $label → schema vs БД"
  ( cd apps/api && DATABASE_URL="$url" \
    npx --no-install prisma migrate diff \
      --from-url "$url" \
      --to-schema-datamodel "../../$schema" \
      --exit-code \
      --script )
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "[prisma:diff] $label: ОК (schema = БД)"
  elif [[ $rc -eq 2 ]]; then
    echo "[prisma:diff] $label: drift detected (см. SQL выше)"
  else
    echo "[prisma:diff] $label: ошибка диагностики (rc=$rc)"
  fi
}

run_dump_db() {
  # Дамп фактической DDL текущей БД (только для main scope; используется
  # при разборе расхождений на уровне constraint-опций). Эквивалент
  # `pg_dump --schema-only` в формате, который Prisma бы сгенерировал.
  local label="$1" schema="$2" url_var="$3" filter="${4:-}"
  local url="${!url_var:-}"
  if [[ -z "$url" || ! -f "$schema" ]]; then
    echo "[prisma:dump-db] skip $label"
    return 0
  fi
  echo "[prisma:dump-db] $label (filter='$filter')"
  local out
  out="$( ( cd apps/api && DATABASE_URL="$url" \
    npx --no-install prisma migrate diff \
      --from-empty \
      --to-url "$url" \
      --script ) 2>/dev/null )"
  if [[ -n "$filter" ]]; then
    grep -iE "$filter" <<<"$out" || echo "(нет совпадений по '$filter')"
  else
    echo "$out"
  fi
}

run_resolve() {
  local label="$1" schema="$2" url_var="$3" mode="$4" name="$5"
  local url="${!url_var:-}"
  if [[ -z "$url" || ! -f "$schema" ]]; then
    echo "[prisma:resolve] skip $label"
    return 0
  fi
  echo "[prisma:resolve] $label → migrate resolve --$mode $name"
  prisma_invoke "$url" "$schema" migrate resolve "--$mode" "$name"
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

dispatch_for_scope() {
  local action="$1"

  # action может быть `resolve-applied:NAME` или `resolve-rolled-back:NAME` —
  # после двоеточия идёт имя миграции (без слэшей и пробелов).
  local mode="" name=""
  case "$action" in
    resolve-applied:*)
      mode="applied"
      name="${action#resolve-applied:}"
      ;;
    resolve-rolled-back:*)
      mode="rolled-back"
      name="${action#resolve-rolled-back:}"
      ;;
  esac

  case "$SCOPE" in
    main)
      case "$action" in
        deploy) run_migrate "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL" ;;
        status) run_status "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL" ;;
        diff)   run_diff   "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL" ;;
        dump-db:*)
          run_dump_db "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL" "${action#dump-db:}" ;;
        dump-db)
          run_dump_db "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL" ;;
        resolve-applied:*|resolve-rolled-back:*)
          run_resolve "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL" "$mode" "$name" ;;
        *) echo "[prisma:migrate] неизвестный ACTION='$action'"; exit 2 ;;
      esac
      ;;
    archive)
      case "$action" in
        deploy) run_migrate "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL" ;;
        status) run_status "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL" ;;
        diff)   run_diff   "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL" ;;
        resolve-applied:*|resolve-rolled-back:*)
          run_resolve "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL" "$mode" "$name" ;;
        *) echo "[prisma:migrate] неизвестный ACTION='$action'"; exit 2 ;;
      esac
      ;;
    broadcasts)
      case "$action" in
        deploy) run_migrate "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL" ;;
        status) run_status "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL" ;;
        diff)   run_diff   "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL" ;;
        resolve-applied:*|resolve-rolled-back:*)
          run_resolve "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL" "$mode" "$name" ;;
        *) echo "[prisma:migrate] неизвестный ACTION='$action'"; exit 2 ;;
      esac
      ;;
    all)
      case "$action" in
        deploy)
          run_migrate "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL"
          run_migrate "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL"
          run_migrate "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL"
          ;;
        status)
          run_status "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL"
          run_status "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL"
          run_status "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL"
          ;;
        diff)
          run_diff "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL"
          run_diff "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL"
          run_diff "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL"
          ;;
        dump-db:*)
          run_dump_db "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL" "${action#dump-db:}"
          ;;
        dump-db)
          run_dump_db "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL"
          ;;
        resolve-applied:*|resolve-rolled-back:*)
          # Resolve действует только на main — для других scope нужно явно
          # указать PRISMA_SCOPE.
          run_resolve "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL" "$mode" "$name"
          ;;
        *) echo "[prisma:migrate] неизвестный ACTION='$action'"; exit 2 ;;
      esac
      ;;
    *)
      echo "[prisma:migrate] неизвестный PRISMA_SCOPE='$SCOPE' (доступно: all|main|archive|broadcasts)" >&2
      exit 2
      ;;
  esac
}

dispatch_for_scope "$ACTION"

echo "[prisma:migrate] готово (scope=$SCOPE, action=$ACTION)"
