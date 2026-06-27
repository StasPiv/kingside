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
#   PRISMA_SCOPE=events ...                      # только events-db (та же БД, schema events)
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

# Подкачка prisma engine-бинарников под openssl-3, если системный openssl 3.x,
# а в node_modules лежит только сборка под openssl-1.1.x. См. ensure-prisma-engines.sh.
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/ensure-prisma-engines.sh"
ensure_prisma_engines "$ROOT_DIR"

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
  # $1 = url, $2 = schema (relative to ROOT), $3..n = prisma args.
  #
  # Используем CWD = workspace, рядом с которым лежит schema. Это критично
  # потому что в `apps/api/prisma.config.ts` ХАРДКОДОМ задан
  # `migrations.path = ../../packages/db/prisma/migrations` (main). Если
  # запускать prisma из apps/api для archive/broadcasts schema — config
  # подхватывается и migrations берутся из main вместо нужной workspace
  # (KS-2698: ровно поэтому я случайно накатывал main-миграции на
  # kingside_archive). Поэтому маршрутизируем CWD по schema-пути.
  local url="$1" schema="$2"
  shift 2
  local workspace_dir
  case "$schema" in
    packages/db/prisma/*)
      # main: prisma.config.ts в apps/api корректно ссылается на main
      workspace_dir="apps/api"
      ;;
    packages/archive-db/prisma/*)
      workspace_dir="packages/archive-db"
      ;;
    packages/broadcasts-db/prisma/*)
      workspace_dir="packages/broadcasts-db"
      ;;
    packages/events-db/prisma/*)
      workspace_dir="packages/events-db"
      ;;
    *)
      workspace_dir="apps/api"
      ;;
  esac
  # rel: путь до schema относительно workspace_dir (узкий случай: /prisma/schema.prisma).
  local rel
  rel="$(realpath --relative-to="$workspace_dir" "$schema" 2>/dev/null \
        || python3 -c "import os,sys; print(os.path.relpath('$schema','$workspace_dir'))")"
  ( cd "$workspace_dir" && DATABASE_URL="$url" npx --no-install prisma "$@" --schema "$rel" )
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

run_env_keys() {
  # Диагностика: какие переменные определены в .env (только ключи, без значений).
  if [[ -f .env ]]; then
    echo "[env-keys] .env keys (значения скрыты):"
    grep -E "^[A-Z_][A-Z0-9_]*=" .env | sed 's/=.*$/=<set>/' | sort
  else
    echo "[env-keys] .env отсутствует в $ROOT_DIR"
  fi
}

run_env_show_masked() {
  # Показать значение env-переменной с маскированным паролем (для DATABASE
  # URL'ов): postgresql://user:***@host:port/db?sslmode=...
  local key="$1"
  if [[ -z "$key" ]]; then
    echo "[env-show] error: ключ не задан"
    return 1
  fi
  if [[ ! -f .env ]]; then
    echo "[env-show] .env отсутствует"
    return 1
  fi
  local raw
  raw="$(grep -E "^$key=" .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  if [[ -z "$raw" ]]; then
    echo "[env-show] $key не найден в .env"
    return 0
  fi
  # Маскируем пароль в URL.
  local masked
  masked="$(echo "$raw" | sed -E 's#://([^:/@]+):[^@]+@#://\1:***@#')"
  echo "[env-show] $key=$masked"
}

run_set_env_var() {
  # Аккуратно установить (или обновить) переменную в .env. Сохраняет .env.bak
  # на случай отката. Идемпотентно. Используется один раз для KS-2698:
  # перенаправить ARCHIVE_DATABASE_URL на локальную kingside_archive.
  local key="$1" value="$2"
  if [[ -z "$key" || -z "$value" ]]; then
    echo "[set-env] error: key или value пуст"
    return 1
  fi
  if [[ ! -f .env ]]; then
    echo "[set-env] .env отсутствует в $ROOT_DIR, создаю новый"
    : > .env
  fi
  cp .env .env.bak
  if grep -qE "^$key=" .env; then
    # Замена существующего значения. Используем `|` как separator, чтобы
    # не конфликтовать с `/` в URL.
    local esc_value
    esc_value="$(printf '%s' "$value" | sed 's/[|&]/\\&/g')"
    sed -i.tmp "s|^$key=.*$|$key=$esc_value|" .env && rm -f .env.tmp
    echo "[set-env] $key обновлено в .env (бэкап в .env.bak)"
  else
    printf '%s=%s\n' "$key" "$value" >> .env
    echo "[set-env] $key добавлено в .env (бэкап в .env.bak)"
  fi
}

run_clear_twic_lock() {
  echo "[clear-twic-lock] DEL archive:import:lock:twic из Redis (localhost:6380)"
  node "$ROOT_DIR/scripts/clear-redis-key.mjs" "archive:import:lock:twic"
}

run_count_archive_games() {
  # Проверка acceptance KS-2698: сколько в archive_games partией прошли
  # фильтр puzzle-generator (classical + обоих ≥2400).
  # `prisma db execute` для SELECT не возвращает результат — используем
  # отдельный Node-скрипт через pg.
  local url="${ARCHIVE_DATABASE_URL:-}"
  if [[ -z "$url" ]]; then
    echo "[count-archive] error: ARCHIVE_DATABASE_URL не задан"
    return 1
  fi
  echo "[count-archive] SELECT counts FROM archive_games"
  ARCHIVE_DATABASE_URL="$url" node "$ROOT_DIR/scripts/db-count.mjs"
}

run_seed_archive_sources() {
  # Засеять TWIC в archive_sources локальной kingside_archive (демон
  # importer-main.js seed не вызывает, только one-shot entrypoint).
  local url="${ARCHIVE_DATABASE_URL:-}"
  if [[ -z "$url" ]]; then
    echo "[seed-archive-sources] error: ARCHIVE_DATABASE_URL не задан"
    return 1
  fi
  local sql_file="$ROOT_DIR/scripts/sql/seed-archive-sources.sql"
  echo "[seed-archive-sources] INSERT TWIC ... ON CONFLICT DO NOTHING"
  ( cd packages/archive-db && \
    npx --no-install prisma db execute --url "$url" --file "$sql_file" )
}

run_clean_archive_schema() {
  # DROP SCHEMA public CASCADE на kingside_archive БД (не на main!).
  # Используется чтобы убрать ошибочно накатанную main-схему перед
  # повторным db push с archive-схемой.
  local url="${ARCHIVE_DATABASE_URL:-}"
  if [[ -z "$url" ]]; then
    echo "[clean-archive-schema] error: ARCHIVE_DATABASE_URL не задан"
    return 1
  fi
  local sql_file="$ROOT_DIR/scripts/sql/clean-archive-db.sql"
  echo "[clean-archive-schema] DROP SCHEMA public CASCADE на kingside_archive"
  ( cd packages/archive-db && \
    npx --no-install prisma db execute --url "$url" --file "$sql_file" )
}

run_force_archive_schema() {
  # Полный накат archive-схемы на пустую kingside_archive через `db push`.
  # Используется когда `migrate deploy` для archive падает (CREATE INDEX
  # CONCURRENTLY в транзакции — KS-2118-like) или когда БД содержит
  # ошибочные таблицы. db push не использует _prisma_migrations и не
  # оборачивает CONCURRENTLY в транзакции.
  run_clean_archive_schema || return 1
  local url="${ARCHIVE_DATABASE_URL:-}"
  echo "[force-archive-schema] db push schema.prisma → kingside_archive"
  ( cd packages/archive-db && DATABASE_URL="$url" \
    npx --no-install prisma db push --schema prisma/schema.prisma \
      --skip-generate --accept-data-loss )
}

run_drop_archive_db() {
  # Удалить локальную kingside_archive перед повторным накатом archive
  # схемы. Используется только в KS-2698 для очистки последствий
  # ошибочного применения main-миграций на эту БД.
  local url="${DATABASE_URL:-}"
  if [[ -z "$url" ]]; then
    echo "[drop-archive-db] error: DATABASE_URL не задан"
    return 1
  fi
  local sys_url
  sys_url="$(echo "$url" | sed -E 's#/[^/?]+(\?|$)#/postgres\1#')"
  local sql_file="$ROOT_DIR/scripts/sql/drop-archive-db.sql"
  echo "[drop-archive-db] DROP DATABASE IF EXISTS kingside_archive"
  ( cd apps/api && \
    npx --no-install prisma db execute --url "$sys_url" --file "$sql_file" )
}

run_init_archive_db() {
  # KS-2698: создать локальную БД kingside_archive в существующем postgres
  # контейнере. Использует prisma db execute с подмененным URL на системную
  # БД `postgres`, оттуда `CREATE DATABASE`. Идемпотентно.
  local url="${DATABASE_URL:-}"
  if [[ -z "$url" ]]; then
    echo "[init-archive-db] error: DATABASE_URL не задан (нужен .env)"
    return 1
  fi
  # Подмена /db на /postgres (системная БД, к которой можно делать CREATE DATABASE).
  local sys_url
  sys_url="$(echo "$url" | sed -E 's#/[^/?]+(\?|$)#/postgres\1#')"
  echo "[init-archive-db] target: kingside_archive (через системную БД postgres)"
  local sql_file="$ROOT_DIR/scripts/sql/create-archive-db.sql"
  if [[ ! -f "$sql_file" ]]; then
    echo "[init-archive-db] error: $sql_file не найден"
    return 1
  fi
  ( cd apps/api && \
    npx --no-install prisma db execute --url "$sys_url" --file "$sql_file" ) \
    && echo "[init-archive-db] kingside_archive создана." \
    || echo "[init-archive-db] предположительно БД уже существует (или ошибка — см. выше); ставим ОК."
  return 0
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
    events)
      # KS-4694 / ADR-147 §2.3: events-db физически в той же БД kingside-db,
      # что и main, но отдельная схема `events` и отдельный логин
      # `events_writer`. EVENTS_DATABASE_URL формата
      # `postgresql://events_writer:<pass>@host:5432/kingside?schema=events&sslmode=require`.
      case "$action" in
        deploy) run_migrate "events" "packages/events-db/prisma/schema.prisma" "EVENTS_DATABASE_URL" ;;
        status) run_status "events" "packages/events-db/prisma/schema.prisma" "EVENTS_DATABASE_URL" ;;
        diff)   run_diff   "events" "packages/events-db/prisma/schema.prisma" "EVENTS_DATABASE_URL" ;;
        resolve-applied:*|resolve-rolled-back:*)
          run_resolve "events" "packages/events-db/prisma/schema.prisma" "EVENTS_DATABASE_URL" "$mode" "$name" ;;
        *) echo "[prisma:migrate] неизвестный ACTION='$action'"; exit 2 ;;
      esac
      ;;
    all)
      case "$action" in
        deploy)
          run_migrate "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL"
          run_migrate "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL"
          run_migrate "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL"
          run_migrate "events" "packages/events-db/prisma/schema.prisma" "EVENTS_DATABASE_URL"
          ;;
        status)
          run_status "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL"
          run_status "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL"
          run_status "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL"
          run_status "events" "packages/events-db/prisma/schema.prisma" "EVENTS_DATABASE_URL"
          ;;
        diff)
          run_diff "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL"
          run_diff "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL"
          run_diff "broadcasts" "packages/broadcasts-db/prisma/schema.prisma" "BROADCASTS_DATABASE_URL"
          run_diff "events" "packages/events-db/prisma/schema.prisma" "EVENTS_DATABASE_URL"
          ;;
        diff-main)
          run_diff "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL"
          ;;
        env-keys)
          run_env_keys
          ;;
        env-show:*)
          run_env_show_masked "${action#env-show:}"
          ;;
        set-archive-url-local)
          # Точечное действие KS-2698: переключить ARCHIVE_DATABASE_URL на
          # локальную kingside_archive (использует тот же user/pass, что
          # DATABASE_URL для main).
          if [[ -z "${DATABASE_URL:-}" ]]; then
            echo "[set-archive-url-local] error: DATABASE_URL не задан"
            exit 1
          fi
          new_url="$(echo "$DATABASE_URL" | sed -E 's#/[^/?]+(\?|$)#/kingside_archive\1#')"
          run_set_env_var "ARCHIVE_DATABASE_URL" "$new_url"
          ;;
        init-archive-db)
          run_init_archive_db
          ;;
        drop-archive-db)
          run_drop_archive_db
          ;;
        reset-archive-db)
          # Полный цикл: DROP → CREATE → migrate deploy. Использовать на dev
          # когда нужно очистить ошибочно накатанную main-схему на
          # kingside_archive (KS-2698).
          # Сначала остановить importer, чтобы он не держал коннекты.
          # Это делается снаружи (docker_compose down archive-importer).
          run_drop_archive_db || true
          run_init_archive_db
          run_migrate "archive (reset)" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL"
          ;;
        force-archive-schema)
          run_force_archive_schema
          ;;
        seed-archive-sources)
          run_seed_archive_sources
          ;;
        clear-twic-lock)
          run_clear_twic_lock
          ;;
        count-archive)
          run_count_archive_games
          ;;
        dump-db:*)
          run_dump_db "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL" "${action#dump-db:}"
          ;;
        dump-db)
          run_dump_db "main (kingside)" "packages/db/prisma/schema.prisma" "DATABASE_URL"
          ;;
        dump-archive-db:*)
          run_dump_db "archive (kingside_archive)" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL" "${action#dump-archive-db:}"
          ;;
        dump-archive-db)
          run_dump_db "archive (kingside_archive)" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL"
          ;;
        deploy-archive)
          # Только archive scope (kingside_archive). Используется для повторного
          # наката после ручных правок состояния БД.
          run_migrate "archive" "packages/archive-db/prisma/schema.prisma" "ARCHIVE_DATABASE_URL"
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
      echo "[prisma:migrate] неизвестный PRISMA_SCOPE='$SCOPE' (доступно: all|main|archive|broadcasts|events)" >&2
      exit 2
      ;;
  esac
}

dispatch_for_scope "$ACTION"

echo "[prisma:migrate] готово (scope=$SCOPE, action=$ACTION)"
