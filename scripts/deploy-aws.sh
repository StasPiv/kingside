#!/bin/bash
# Deploy Kingside to AWS (S3 + CloudFront + ECR + ECS)
#
# Usage:
#   bash scripts/deploy-aws.sh            — auto-detect scope
#   bash scripts/deploy-aws.sh frontend   — force frontend only
#   bash scripts/deploy-aws.sh api        — force API only
#   bash scripts/deploy-aws.sh game-service — force game-service only
#   bash scripts/deploy-aws.sh all        — force full deploy
#
# =====================================================================
# KS-1826: ECR tag atomicity — semantics тегов
# =====================================================================
# `<repo>:<sha>` — артефакт сборки. Пушится первым, до каких-либо gate'ов.
# `<repo>:latest` — указывает на последний успешно задеплоенный и прошедший
#                   все gate'ы (migrate + services-stable + smoke) образ.
#                   Перемещается атомарно через `aws ecr put-image` ТОЛЬКО
#                   в конце блока, когда все gate'ы успешны.
#
# Task-def revisions регистрируются с явным `<sha>` в image (НЕ :latest).
# Это даёт чистый откат: `update-service --task-definition <prev-revision>`.
#
# Почему так:
# - Если migrate/services-stable/smoke падает — `:latest` остаётся на
#   предыдущем удачном digest. ECS auto-heal (health-check replace, scale-up,
#   task crash replace) и ручные run-task (TWIC-batch, CLI, backfill) — всё
#   продолжает тянуть проверенный образ.
# - Без атомарности (как было до KS-1826) падение любого gate оставляло
#   `:latest` на сломанном digest → ECS auto-heal поднимал crash-looping таски
#   параллельно с правильным rollout. См. постмортем 24.04 в KS-1817.
#
# Runbook отката деплоя (KS-1826):
#   1. Посмотреть текущую revision и откатиться на предыдущую:
#        FAM=kingside-broadcast-service            # или другое family
#        SVC=kingside-broadcast-service            # или другой ECS-сервис
#        CUR=$(aws ecs describe-services --cluster kingside --services "$SVC" \
#              --query 'services[0].taskDefinition' --output text)
#        REV=${CUR##*:}; PREV=$((REV-1))
#        aws ecs update-service --cluster kingside --service "$SVC" \
#          --task-definition "${FAM}:${PREV}" --force-new-deployment
#        aws ecs wait services-stable --cluster kingside --services "$SVC"
#   2. `:latest` уже указывает на предыдущий удачный digest — трогать не надо.
#   3. Сломанная revision остаётся как артефакт. Почистить при желании:
#        aws ecs deregister-task-definition --task-definition "${FAM}:${REV}"
# =====================================================================
#
# =====================================================================
# KS-1897: archive-service — несколько task-def family на одном образе
# =====================================================================
# Образ kingside-archive-service используется тремя task-def family:
#   - kingside-archive-service           — ECS service (HTTP, /tree)
#   - kingside-archive-importer-oneshot  — EventBridge daily (kingside-archive-importer-daily)
#   - kingside-archive-importer-adhoc    — adhoc batch / dev (manual aws ecs run-task)
# Legacy family kingside-archive-importer (наследие ADR-019, без потребителя)
# дерегистрирована в C-следствии KS-1897 после первой выкатки B.
#
# До KS-1897 deploy-pipeline обновлял revision только для тех family, у которых
# есть ECS service (`update-service` ветка). Остальные оставались на :latest и
# полагались на Fargate fresh-pull. Минусы:
#   1. Изменения env/secrets/CPU/memory в task-def-шаблоне не доходили до
#      EventBridge и adhoc-запусков до явного manual register-task-definition.
#   2. Если atomic put-image :latest падал на полпути, отката на pinned SHA
#      не было — task-def указывал на :latest без revision-фоллбэка.
#   3. Расхождение текущих task-def шаблонов с шаблоном HTTP-сервиса.
#
# С KS-1897 на каждом scope=archive-service деплое:
#   а) Регистрируем новый revision для каждой из ARCHIVE_TD_FAMILIES с image=:<sha>
#      (идемпотентно: если последний revision уже на нужном image, повторно
#      не регистрируем).
#   б) Обновляем EventBridge Schedule kingside-archive-importer-daily на ARN
#      свежего oneshot-revision.
#   в) ECS update-service по-прежнему запускается только для существующих
#      ACTIVE сервисов (архитектурно сейчас это только HTTP).
#   г) Атомарный move :latest → :<sha> делается ПОСЛЕ всех регистраций и
#      успешных gate'ов (migrate / services-stable / smoke). Pinned SHA в
#      task-def family даёт фоллбэк, если :latest развалится.
# =====================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# =====================================================================
# KS-2993 / KS-3057: Deploy mutex (flock) — блокировка параллельных деплоев
# =====================================================================
# Параллельные деплои одного scope ломали прод: два frontend-build'а
# заливались в S3 с --delete почти одновременно, второй сносил чанки
# первого (KS-2993, инцидент 14.05.2026). Однако одновременные деплои
# *разных* сервисов корректности не нарушают: каждый пишет в свой ECR-репо
# и обновляет свой ECS-сервис.
#
# KS-3057: вместо одного общего lock'а — двухуровневая схема (классический
# readers-writers через flock -s/-x):
#
#   1) `.deploy.lock` (master, shared/exclusive).
#      - per-scope деплои берут SHARED (-s): много readers одновременно.
#      - `scope:all` берёт EXCLUSIVE (-x): writer, ждёт всех readers.
#
#   2) `.deploy.<scope>.lock` (per-scope, exclusive).
#      - каждый scope (frontend / api / game-service / broadcast-service /
#        archive-service / tactic-worker / synthetic-bot) — свой lock.
#      - два деплоя одного scope не идут параллельно (frontend-инцидент).
#      - `scope:all` не использует per-scope lock'и (берёт master exclusive).
#
# Это даёт: deploy api + deploy broadcast-service параллельны; два
# deploy broadcast-service последовательны; deploy all ждёт всех и
# блокирует новых.
#
# Решение через re-exec `flock(1)`: flock-parent держит fd на lock-файле,
# deploy-скрипт — child. fd не наследуется дочерним aws/npm/docker
# (--close, флаг -o), lock освобождается ровно когда flock-parent умирает
# — независимо от orphan-child'ов после краха скрипта (KS-2993).
#
# Двухуровневый re-exec: первый под master, второй под per-scope.
# Цепочка процессов: flock(master) → flock(per-scope) → deploy-aws.sh.
# Маркеры в env:
#   KINGSIDE_DEPLOY_LOCK_MASTER_HELD=1 — уже под master flock.
#   KINGSIDE_DEPLOY_LOCK_SCOPE_HELD=1  — уже под per-scope flock (финал).
#
# Bypass для отладки: KINGSIDE_DEPLOY_SKIP_LOCK=1 пропускает acquire.
#
# Stale-таймаут 15 мин (DEPLOY_LOCK_STALE_WARN_SEC) — только информативный
# warn при отказе. Force-override НЕ делаем: легитимный `deploy all` с
# миграциями может идти дольше 15 мин, ручное снятие lock'а сломает
# текущий деплой. Если процесс реально мёртв — flock сам освободит.
# =====================================================================
DEPLOY_LOCK_FILE="$REPO_DIR/.deploy.lock"
DEPLOY_LOCK_STALE_WARN_SEC=900
DEPLOY_LOCK_EXIT_CODE=75

# Список валидных per-scope значений (`workers` раскладывается в два
# scope'а, поэтому здесь его нет — он обрабатывается отдельно ниже).
DEPLOY_SCOPES_WITH_PER_LOCK=(frontend api game-service broadcast-service archive-service tactic-worker synthetic-bot)

# Файл per-scope lock'а для конкретного scope.
deploy_scope_lock_file() {
    echo "$REPO_DIR/.deploy.${1}.lock"
}

# Описание holder'а: читаем метаданные из lock-файла + вычисляем возраст.
# Аргументы: $1 — путь к lock-файлу, $2 — префикс лога ("master" / "scope/api").
_deploy_lock_print_holder() {
    local lock_file="$1"
    local label="$2"
    local holder_info lock_mtime now age
    holder_info="$(cat "$lock_file" 2>/dev/null || echo '<no metadata>')"
    if ! lock_mtime=$(stat -c '%Y' "$lock_file" 2>/dev/null); then
        lock_mtime=$(stat -f '%m' "$lock_file" 2>/dev/null || echo 0)
    fi
    now=$(date +%s)
    age=$((now - lock_mtime))
    echo "[deploy-lock $label] Holder metadata:" >&2
    echo "$holder_info" | sed 's/^/  /' >&2
    echo "[deploy-lock $label] Lock age: ${age}s" >&2
    if [ "$age" -gt "$DEPLOY_LOCK_STALE_WARN_SEC" ]; then
        echo "[deploy-lock $label] WARN: lock is older than ${DEPLOY_LOCK_STALE_WARN_SEC}s — holder may be hung." >&2
        echo "[deploy-lock $label] If you're sure the holder is dead, kill its PID — flock releases automatically." >&2
    else
        echo "[deploy-lock $label] Retry after the current deploy completes." >&2
    fi
}

# =====================================================================
# Acquire deploy locks (двухуровневая схема, KS-3057).
# Вызывается ПОСЛЕ резолва SCOPE.
#
# Аргументы: $1 — резолвленный scope (frontend / api / game-service /
# broadcast-service / archive-service / tactic-worker / synthetic-bot /
# workers / all).
#
# Re-exec проходит в три этапа (внутренние маркеры в env):
#   0) Нет маркеров → probe master. Probe прошёл → re-exec под flock-master.
#   1) `*_MASTER_HELD=1`, нет SCOPE_HELD → если scope==all, финал; иначе
#      probe per-scope, re-exec под flock-per-scope. Для workers — две
#      последовательные re-exec'ии (по одному per-scope за раз).
#   2) `*_SCOPE_HELD=1` → финал, записываем метаданные, ставим trap.
# =====================================================================
acquire_deploy_locks() {
    if [ "${KINGSIDE_DEPLOY_SKIP_LOCK:-0}" = "1" ]; then
        echo "[deploy-lock] KINGSIDE_DEPLOY_SKIP_LOCK=1 — bypassing mutex (debug mode)"
        return 0
    fi
    local scope="$1"

    local master_held="${KINGSIDE_DEPLOY_LOCK_MASTER_HELD:-0}"
    local scope_held="${KINGSIDE_DEPLOY_LOCK_SCOPE_HELD:-0}"

    # Финал: оба уровня уже у нас (или master+all). Пишем метаданные и trap.
    if [ "$scope_held" = "1" ] || { [ "$master_held" = "1" ] && [ "$scope" = "all" ]; }; then
        local primary_lock_file
        if [ "$scope" = "all" ]; then
            primary_lock_file="$DEPLOY_LOCK_FILE"
        else
            # При workers выбираем lock-файл с pid'ом текущего процесса как «маяк»
            # (имя scope записываем по реальному режиму "workers", чтобы holder
            # metadata показывала правильный режим).
            primary_lock_file="$(deploy_scope_lock_file "$scope")"
        fi
        : > "$primary_lock_file"
        {
            echo "pid=$$"
            echo "scope=$scope"
            echo "agent=${AGENT_NAME:-${USER:-unknown}}"
            echo "started_at=$(date -Iseconds 2>/dev/null || date)"
            echo "started_unix=$(date +%s)"
            echo "host=$(hostname 2>/dev/null || echo unknown)"
        } >> "$primary_lock_file"
        trap '_deploy_lock_release_trap' EXIT
        echo "[deploy-lock] Acquired (scope=$scope, pid=$$, agent=${AGENT_NAME:-${USER:-unknown}})"
        return 0
    fi

    # Этап 0 → 1: probe + re-exec под master.
    if [ "$master_held" = "0" ]; then
        [ -e "$DEPLOY_LOCK_FILE" ] || : > "$DEPLOY_LOCK_FILE"
        exec 199>>"$DEPLOY_LOCK_FILE"
        local flock_mode_probe flock_mode_real
        if [ "$scope" = "all" ]; then
            flock_mode_probe="-n -x"
            flock_mode_real="-n -E $DEPLOY_LOCK_EXIT_CODE -o -x"
        else
            flock_mode_probe="-n -s"
            flock_mode_real="-n -E $DEPLOY_LOCK_EXIT_CODE -o -s"
        fi
        # shellcheck disable=SC2086
        if ! flock $flock_mode_probe 199; then
            echo "[deploy-lock master] ERROR: cannot acquire master lock as ${flock_mode_probe} (scope=$scope)." >&2
            _deploy_lock_print_holder "$DEPLOY_LOCK_FILE" "master"
            exit 1
        fi
        # Probe прошёл — отпускаем fd 199, под flock-wrapper возьмём свой.
        flock -u 199
        exec 199<&-

        export KINGSIDE_DEPLOY_LOCK_MASTER_HELD=1
        # shellcheck disable=SC2086
        exec flock $flock_mode_real "$DEPLOY_LOCK_FILE" "$0" "$@"
    fi

    # Этап 1 → 2: уже под master. Берём per-scope (или финал для all).
    if [ "$scope" = "all" ]; then
        # all: per-scope не нужен. Финал — снова в верхнюю ветку (через
        # рекурсивный вызов с обновлёнными маркерами).
        export KINGSIDE_DEPLOY_LOCK_SCOPE_HELD=1
        acquire_deploy_locks "$scope"
        return $?
    fi

    if [ "$scope" = "workers" ]; then
        # workers = broadcast-service + archive-service. Берём ОБА per-scope
        # lock'а через цепочку из двух re-exec'ов. Маркер промежуточного
        # состояния — KINGSIDE_DEPLOY_LOCK_WORKERS_STAGE.
        local workers_stage="${KINGSIDE_DEPLOY_LOCK_WORKERS_STAGE:-0}"
        local scope_lock_file scope_label
        if [ "$workers_stage" = "0" ]; then
            scope_lock_file="$(deploy_scope_lock_file broadcast-service)"
            scope_label="scope/broadcast-service"
            [ -e "$scope_lock_file" ] || : > "$scope_lock_file"
            exec 198>>"$scope_lock_file"
            if ! flock -n -x 198; then
                echo "[deploy-lock $scope_label] ERROR: per-scope lock busy (workers needs broadcast-service)." >&2
                _deploy_lock_print_holder "$scope_lock_file" "$scope_label"
                exit 1
            fi
            flock -u 198
            exec 198<&-
            export KINGSIDE_DEPLOY_LOCK_WORKERS_STAGE=1
            exec flock -n -E "$DEPLOY_LOCK_EXIT_CODE" -o -x "$scope_lock_file" "$0" "$@"
        elif [ "$workers_stage" = "1" ]; then
            scope_lock_file="$(deploy_scope_lock_file archive-service)"
            scope_label="scope/archive-service"
            [ -e "$scope_lock_file" ] || : > "$scope_lock_file"
            exec 197>>"$scope_lock_file"
            if ! flock -n -x 197; then
                echo "[deploy-lock $scope_label] ERROR: per-scope lock busy (workers needs archive-service)." >&2
                _deploy_lock_print_holder "$scope_lock_file" "$scope_label"
                exit 1
            fi
            flock -u 197
            exec 197<&-
            export KINGSIDE_DEPLOY_LOCK_WORKERS_STAGE=2
            export KINGSIDE_DEPLOY_LOCK_SCOPE_HELD=1
            exec flock -n -E "$DEPLOY_LOCK_EXIT_CODE" -o -x "$scope_lock_file" "$0" "$@"
        fi
    fi

    # Обычный per-scope (один lock).
    local scope_lock_file scope_label
    scope_lock_file="$(deploy_scope_lock_file "$scope")"
    scope_label="scope/$scope"
    [ -e "$scope_lock_file" ] || : > "$scope_lock_file"
    exec 198>>"$scope_lock_file"
    if ! flock -n -x 198; then
        echo "[deploy-lock $scope_label] ERROR: per-scope lock busy (scope=$scope)." >&2
        _deploy_lock_print_holder "$scope_lock_file" "$scope_label"
        exit 1
    fi
    flock -u 198
    exec 198<&-

    export KINGSIDE_DEPLOY_LOCK_SCOPE_HELD=1
    exec flock -n -E "$DEPLOY_LOCK_EXIT_CODE" -o -x "$scope_lock_file" "$0" "$@"
}

_deploy_lock_release_trap() {
    # flock-parent освобождает lock при exit. Опустошаем lock-файлы, чтобы
    # следующий запуск не видел stale метаданные предыдущего владельца.
    local scope="${KINGSIDE_DEPLOY_RESOLVED_SCOPE:-}"
    if [ "$scope" = "all" ]; then
        : > "$DEPLOY_LOCK_FILE" 2>/dev/null || true
    elif [ "$scope" = "workers" ]; then
        : > "$(deploy_scope_lock_file broadcast-service)" 2>/dev/null || true
        : > "$(deploy_scope_lock_file archive-service)" 2>/dev/null || true
    elif [ -n "$scope" ]; then
        : > "$(deploy_scope_lock_file "$scope")" 2>/dev/null || true
    fi
}

# =====================================================================
# Git-sync lock (KS-3057) — короткий flock на время git fetch+ff-only.
# Защищает .git/index.lock от race между параллельными деплоями разных
# scope'ов (которые теперь стартуют одновременно). Держится секунды;
# параллелизм AWS-этапов не затрагивает.
# =====================================================================
GIT_SYNC_LOCK_FILE="$REPO_DIR/.git-sync.lock"

acquire_git_sync_lock() {
    [ -e "$GIT_SYNC_LOCK_FILE" ] || : > "$GIT_SYNC_LOCK_FILE"
    exec 196>>"$GIT_SYNC_LOCK_FILE"
    # Ждём до 60 с — git fetch+ff-only обычно укладывается в 1-3 с.
    if ! flock -w 60 196; then
        echo "[git-sync-lock] WARN: could not acquire .git-sync.lock within 60s, proceeding without it" >&2
        exec 196<&-
        return 0
    fi
}

release_git_sync_lock() {
    flock -u 196 2>/dev/null || true
    exec 196<&- 2>/dev/null || true
}

# AWS config
REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID="342946498289"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-api"
ECR_URI_GAME="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-game-service"
ECR_URI_BROADCAST_SERVICE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-broadcast-service"
ECR_URI_ARCHIVE_SERVICE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-archive-service"
# KS-2440 / ADR-042 §9.1-§9.2: tactic-worker — NestJS standalone CLI, запускается
# через ECS RunTask (drill-индексер, sf-validate, puzzle-генератор).
# ECS service'а нет — pipeline аналогичен archive-importer-adhoc (build → push :<sha> →
# register task-def revision → atomic :latest без update-service / smoke).
ECR_URI_TACTIC_WORKER="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-tactic-worker"
# Короткие имена ECR-repo для aws ecr put-image / batch-get-image.
ECR_REPO_API="kingside-api"
ECR_REPO_GAME="kingside-game-service"
ECR_REPO_BROADCAST_SERVICE="kingside-broadcast-service"
ECR_REPO_ARCHIVE_SERVICE="kingside-archive-service"
ECR_REPO_TACTIC_WORKER="kingside-tactic-worker"
S3_BUCKET="kingside-frontend-${ACCOUNT_ID}"
CF_DISTRIBUTION="E1ECCUC177NSGI"
ECS_CLUSTER="kingside"
ECS_SERVICE="kingside-api"
ECS_SERVICE_GAME="kingside-game-service"
# Task-def families (ECS task-definition name, не ECS-service).
TD_FAMILY_API="kingside-api"
TD_FAMILY_GAME="kingside-game-service"
TD_FAMILY_BROADCAST_SERVICE="kingside-broadcast-service"
TD_FAMILY_ARCHIVE_SERVICE="kingside-archive-service"
TD_FAMILY_ARCHIVE_IMPORTER="kingside-archive-importer"
# KS-2440: task-def family для tactic-worker. Один family на все subcommand'ы
# (index-tactic-drills / sf-validate / generate-puzzles), реальная команда
# передаётся через containerOverrides при RunTask.
TD_FAMILY_TACTIC_WORKER="kingside-tactic-worker"
# KS-1897: все task-def family использующие образ kingside-archive-service.
# Регистрируются на pinned SHA при каждом scope=archive-service деплое
# (см. шапку файла, секцию KS-1897).
# Legacy family `kingside-archive-importer` (ADR-019, без потребителя) дерегистрирована
# в C-следствии KS-1897 после первой успешной выкатки B (revision 6 и 7 → INACTIVE).
ARCHIVE_TD_FAMILIES=(
    "kingside-archive-service"            # ECS service (HTTP, /tree)
    "kingside-archive-importer-oneshot"   # EventBridge schedule kingside-archive-importer-daily
    "kingside-archive-importer-adhoc"     # adhoc batch / dev (manual aws ecs run-task)
)
# EventBridge Scheduler, таргетящий kingside-archive-importer-oneshot.
# После регистрации новой revision oneshot обновляем target ARN расписания.
ES_SCHEDULE_ARCHIVE_DAILY="kingside-archive-importer-daily"
# ADR-021: отдельный сервис для REST+WS broadcasts на broadcasts.kingside.site.
# ADR-022 (KS-1709): kingside-broadcast-worker удалён, sync-цикл выполняется внутри broadcast-service.
ECS_SERVICE_BROADCAST_SERVICE="kingside-broadcast-service"
# ADR-019: единый образ archive-service обслуживает два ECS-сервиса: HTTP и importer.
ECS_SERVICE_ARCHIVE_SERVICE="kingside-archive-service"
ECS_SERVICE_ARCHIVE_IMPORTER="kingside-archive-importer"
# Prod values hardcoded — DO NOT use ${VITE_*:-default}:
# локальные VITE_* (dev: ws://localhost:3002) в env webhook-server/хоста
# перебивали дефолты и попадали в prod-бандл. См. KS-1570.
PROD_API_URL="https://kingside.site"
# VITE_API_URL теперь указывает на api-субдомен (KS-1643 / ADR-017).
# VITE_APP_ORIGIN остаётся на корне — для Telegram OAuth redirect.
PROD_VITE_API_URL="https://api.kingside.site"
# VITE_ARCHIVE_URL — выделенный поддомен для archive-service (KS-1662 / ADR-018 §2.7).
# Fallback на VITE_API_URL во фронте не используется: archiveUrl.js бросает исключение
# при загрузке модуля, если переменная не задана.
PROD_VITE_ARCHIVE_URL="https://archive.kingside.site"
# VITE_BROADCAST_URL — выделенный поддомен для broadcast-service (KS-1696 / ADR-021 §6).
# Fallback на VITE_API_URL не используется: broadcastUrl.ts кидает Error при загрузке
# модуля, если переменная не задана (broadcast-страницы eager-loaded в App.tsx).
PROD_VITE_BROADCAST_URL="https://broadcasts.kingside.site"
PROD_GAME_URL="wss://game.kingside.site"
PROD_GA4_ID="G-9HF8RVMK8K"
# KS-1820: feature-flag раздела «Уроки». На проде явно выключен, во фронте
# также есть fallback на import.meta.env.DEV (см. KS-1820 / commit 378d2b8c).
# KS-2100/KS-2102 follow-up: после раскатки локализации курсов и
# переключателя языка включаем «Уроки» на проде.
PROD_VITE_FEATURE_LESSONS="true"
DEPLOY_COMMIT_FILE="$REPO_DIR/.deploy-commit-aws"

# Load .env
if [ -f "$REPO_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$REPO_DIR/.env"
    set +a
fi

export AWS_DEFAULT_REGION="$REGION"

# =====================================================================
# KS-3048 / ADR-045: инструментирование таймингов этапов деплоя
# =====================================================================
# Пишет таймстампы (ms-precision) в /project/logs/deploy-perf-<ts>-<pid>.log.
# Включено всегда (накладные расходы — date + echo, доли мс на этап).
# Файл уникален по timestamp+PID → параллельные запуски не пересекаются
# (хотя acquire_deploy_locks через flock и так блокирует параллелизм одного scope).
#
# Формат строки: <epoch_ms>\t<stage_name>
# Парсится отдельно (см. docs/devops/deploy-perf-baseline.md).
#
# Финальный _perf_summary в конце скрипта выводит таблицу дельт между
# соседними stamps в человеческом виде (помогает читать deploy-логи без
# отдельного парсинга).
PERF_TRACE_FILE=""
_perf_stamp() {
    if [ -z "$PERF_TRACE_FILE" ]; then
        mkdir -p "$REPO_DIR/logs" 2>/dev/null || return 0
        PERF_TRACE_FILE="$REPO_DIR/logs/deploy-perf-$(date +%Y%m%d-%H%M%S)-$$.log"
        echo "[perf-trace] writing to $PERF_TRACE_FILE" >&2
    fi
    printf '%s\t%s\n' "$(date +%s%3N)" "$1" >> "$PERF_TRACE_FILE"
}
_perf_summary() {
    [ -n "$PERF_TRACE_FILE" ] && [ -f "$PERF_TRACE_FILE" ] || return 0
    echo ""
    echo "=== Deploy perf summary (KS-3048) ==="
    awk -F'\t' '
        NR==1 { prev_t=$1; prev_s=$2; start_t=$1; next }
        {
            delta=($1-prev_t)/1000.0
            printf "  %7.2fs   %-40s -> %s\n", delta, prev_s, $2
            prev_t=$1; prev_s=$2
        }
        END {
            total=(prev_t-start_t)/1000.0
            printf "  ------- ------------------------------------- ----------------------\n"
            printf "  %7.2fs   TOTAL                                    (%s stamps)\n", total, NR
        }
    ' "$PERF_TRACE_FILE"
    echo "  raw trace: $PERF_TRACE_FILE"
    echo "====================================="
}

_perf_stamp "00_init"

# KS-2085 follow-up: подтянуть актуальный main в $REPO_DIR перед сборкой.
# Раньше DEPLOY_SHA брался из произвольного локального HEAD — если у запускающего
# был stale checkout, прод собирался без свежих коммитов (KS-2086/KS-2087 case).
# Теперь явно: fetch + fast-forward main. По проектному правилу деплой идёт
# только из main (нет feature-веток), поэтому checkout другой ветки = ошибка.
# Отключить можно через KINGSIDE_DEPLOY_SKIP_GIT_PULL=1 (для отладки/hotfix
# из специально подготовленного HEAD).
ensure_main_synced() {
    if [ "${KINGSIDE_DEPLOY_SKIP_GIT_PULL:-0}" = "1" ]; then
        echo "[pre-deploy] KINGSIDE_DEPLOY_SKIP_GIT_PULL=1 — skipping git fetch/pull (using whatever HEAD is)"
        return 0
    fi
    local branch
    branch="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
    if [ "$branch" != "main" ]; then
        echo "[pre-deploy] ERROR: current branch is '$branch', deploy expects 'main'." >&2
        echo "[pre-deploy] Switch to main and retry, or set KINGSIDE_DEPLOY_SKIP_GIT_PULL=1 to bypass." >&2
        exit 1
    fi
    # Информативный warn про локальные правки — не блокируем deploy.
    # Untracked файлы (??) игнорируются всегда (test-results, локальные конфиги).
    # Modified/Deleted tracked файлы оставляем как есть; ff-merge ниже либо
    # успешно их сохранит, либо фейл скажет про конфликт.
    if ! git -C "$REPO_DIR" diff-index --quiet HEAD --; then
        echo "[pre-deploy] WARN: working tree has tracked modifications (will be preserved if ff-clean):" >&2
        git -C "$REPO_DIR" diff --name-only HEAD -- 2>/dev/null | head -10 | sed 's/^/  /' >&2
    fi
    echo "[pre-deploy] git fetch origin main..."
    if ! git -C "$REPO_DIR" fetch --quiet origin main; then
        echo "[pre-deploy] WARN: git fetch failed (network/auth). Building from local HEAD." >&2
        return 0
    fi
    local local_sha remote_sha
    local_sha="$(git -C "$REPO_DIR" rev-parse HEAD)"
    remote_sha="$(git -C "$REPO_DIR" rev-parse origin/main)"
    if [ "$local_sha" = "$remote_sha" ]; then
        echo "[pre-deploy] main already at origin/main (${remote_sha:0:7})"
        return 0
    fi
    # Случай 1: HEAD — предок origin/main → fast-forward подтянет remote.
    if git -C "$REPO_DIR" merge-base --is-ancestor HEAD origin/main; then
        echo "[pre-deploy] fast-forward main: ${local_sha:0:7} → ${remote_sha:0:7}"
        if ! git -C "$REPO_DIR" merge --ff-only --quiet origin/main; then
            echo "[pre-deploy] ERROR: fast-forward merge failed (likely local edits conflict with incoming changes)." >&2
            echo "[pre-deploy] Stash conflicting files manually, or set KINGSIDE_DEPLOY_SKIP_GIT_PULL=1 to bypass." >&2
            exit 1
        fi
        return 0
    fi
    # Случай 2: origin/main — предок HEAD → локально уже впереди (есть коммиты,
    # которые ещё не запушены, например агентские). Деплоим локальный HEAD.
    # Это нормально для нашего workflow: агенты коммитят в main локально,
    # пользователь пушит позже.
    if git -C "$REPO_DIR" merge-base --is-ancestor origin/main HEAD; then
        local ahead
        ahead="$(git -C "$REPO_DIR" rev-list --count "origin/main..HEAD")"
        echo "[pre-deploy] local main is ahead of origin/main by $ahead commit(s) (${remote_sha:0:7} → ${local_sha:0:7})"
        echo "[pre-deploy] deploying local HEAD; push to origin when convenient"
        return 0
    fi
    # Случай 3: ветки разошлись — fail.
    echo "[pre-deploy] ERROR: local main and origin/main have diverged." >&2
    echo "[pre-deploy] Local HEAD ${local_sha:0:7}, origin/main ${remote_sha:0:7}." >&2
    echo "[pre-deploy] Rebase manually, or set KINGSIDE_DEPLOY_SKIP_GIT_PULL=1 to bypass." >&2
    exit 1
}
_perf_stamp "01_pre_git_sync"
# KS-3057: git fetch+ff-only — под коротким flock'ом на .git-sync.lock,
# защищаем .git/index.lock от race между параллельными per-scope деплоями.
# Пропускаем повторный fetch если уже под master flock (re-exec): HEAD уже
# на нужном sha, повторный fetch — лишняя операция.
if [ "${KINGSIDE_DEPLOY_LOCK_MASTER_HELD:-0}" = "0" ]; then
    acquire_git_sync_lock
    ensure_main_synced
    release_git_sync_lock
fi
_perf_stamp "02_post_git_sync"

# SHA текущего HEAD — используется и как docker-тег, и как ECR tag.
DEPLOY_SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD)"

# --- Helpers ---

fix_symlinks() {
    for d in apps/web/node_modules apps/api/node_modules; do
        if [ -L "$REPO_DIR/$d" ] && [ "$(readlink "$REPO_DIR/$d")" = "$REPO_DIR/$d" ]; then
            echo "[pre-deploy] Removed circular symlink: $d"
            rm "$REPO_DIR/$d"
        fi
    done
}

ensure_deps() {
    if [ ! -d "$REPO_DIR/node_modules/vite" ]; then
        echo "[pre-deploy] node_modules missing — npm install..."
        npm install --prefix "$REPO_DIR" 2>&1 | tail -3
    fi
}

# jq нужен только для ECR/ECS блоков (register-task-definition). Frontend-only
# деплой его не требует — проверяем лениво перед первым использованием.
ensure_jq() {
    if ! command -v jq >/dev/null 2>&1; then
        echo "[pre-deploy] ERROR: 'jq' is required (KS-1826: task-def revision rewrite). Install: apt-get install jq / brew install jq"
        exit 1
    fi
}

get_deployed_commit() {
    cat "$DEPLOY_COMMIT_FILE" 2>/dev/null || echo ""
}

save_deployed_commit() {
    local commit
    commit=$(git -C "$REPO_DIR" rev-parse HEAD)
    echo "$commit" > "$DEPLOY_COMMIT_FILE"
    echo "  Saved deploy commit: ${commit:0:7}"
}

# =====================================================================
# KS-3049 / ADR-045 §5.1: skip `prisma migrate` run-task если нет
# pending миграций
# =====================================================================
# Fargate run-task для `prisma migrate deploy` гонится 60–90 с
# (image pull + task lifecycle + migrate apply). На warm-деплое без
# изменений миграций — это чистый overhead, схема уже актуальна.
#
# Алгоритм:
#   1. last_sha = .deploy-commit-aws (записывается ТОЛЬКО при успешном
#      завершении предыдущего деплоя). Если файла нет / SHA не в git
#      history — safe-default: запускаем migrate.
#   2. HEAD == last_sha → схема точно актуальна (если предыдущий деплой
#      прошёл успешно, _prisma_migrations не отстаёт от HEAD).
#   3. git diff --name-only $last_sha..HEAD -- $migrations_path
#      → если пусто, миграций не добавлялось/не менялось → skip.
#   4. Иначе — запускаем как обычно.
#
# Идемпотентность Prisma: если skip ошибочно решил пропустить (нп.
# .deploy-commit-aws был обновлён, но migrate упал, и потом восстановили
# вручную) — фоллбэк через docker-entrypoint.sh у api (запускает
# `prisma migrate deploy` на старте контейнера). Для broadcast/archive
# такого фоллбэка нет → их skip более рискован, но при честно ведущемся
# .deploy-commit-aws (обновляется только в конце успешного деплоя)
# проблема не возникает.
#
# Возврат: 0 = «нужно запускать migrate», 1 = «skip, схема up-to-date».
# Безопасный default — возврат 0 при любой неуверенности.
#
# Аргументы:
#   $1 — label сервиса (для лога), например "api" / "broadcast" / "archive"
#   $2 — относительный путь к папке миграций, например
#        "apps/api/prisma/migrations"
should_run_migrate() {
    local svc_label="$1"
    local migrations_path="$2"
    local last_sha
    last_sha=$(get_deployed_commit)
    if [ -z "$last_sha" ]; then
        echo "[migrate-check $svc_label] no .deploy-commit-aws baseline → run migrate (safe default)"
        return 0
    fi
    if ! git -C "$REPO_DIR" rev-parse --quiet --verify "${last_sha}^{commit}" >/dev/null 2>&1; then
        echo "[migrate-check $svc_label] last sha ${last_sha:0:7} not in git history → run migrate (safe default)"
        return 0
    fi
    local current_sha
    current_sha=$(git -C "$REPO_DIR" rev-parse HEAD)
    if [ "$last_sha" = "$current_sha" ]; then
        echo "[migrate-check $svc_label] HEAD unchanged since last deploy (${last_sha:0:7}) → skip migrate"
        return 1
    fi
    if [ ! -d "$REPO_DIR/$migrations_path" ]; then
        echo "[migrate-check $svc_label] migrations dir '$migrations_path' missing → run migrate (safe default)"
        return 0
    fi
    local diff
    diff=$(git -C "$REPO_DIR" diff --name-only "$last_sha"..HEAD -- "$migrations_path" 2>/dev/null || echo "__diff_failed__")
    if [ "$diff" = "__diff_failed__" ]; then
        echo "[migrate-check $svc_label] git diff failed → run migrate (safe default)"
        return 0
    fi
    if [ -n "$diff" ]; then
        echo "[migrate-check $svc_label] migration changes since ${last_sha:0:7}:"
        echo "$diff" | sed 's/^/  /'
        return 0
    fi
    echo "[migrate-check $svc_label] no migration changes in '$migrations_path' since ${last_sha:0:7} → skip migrate"
    return 1
}

# KS-1826: кэш VPC/subnet/sg — одинаков для всех migrate-run-task. Ленивая
# инициализация, чтобы dry-scope-проверки не вызывали AWS API без необходимости.
MIGRATE_VPC_ID=""
MIGRATE_SUBNET=""
MIGRATE_SG=""
ensure_migrate_network() {
    if [ -n "$MIGRATE_VPC_ID" ]; then return; fi
    MIGRATE_VPC_ID=$(aws ec2 describe-vpcs \
        --filters "Name=cidr-block,Values=10.0.0.0/16" \
        --query 'Vpcs[0].VpcId' --output text)
    MIGRATE_SUBNET=$(aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=$MIGRATE_VPC_ID" "Name=cidr-block,Values=10.0.1.0/24" \
        --query 'Subnets[0].SubnetId' --output text)
    MIGRATE_SG=$(aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=kingside-ecs-sg" "Name=vpc-id,Values=$MIGRATE_VPC_ID" \
        --query 'SecurityGroups[0].GroupId' --output text)
}

# KS-1826: регистрирует новую revision ECS task-def, меняя image во всех
# containerDefinitions. Возвращает полный ARN новой revision (stdout).
# Используем jq для очистки read-only полей (aws-cli не принимает их обратно).
register_new_task_def_with_image() {
    local family=$1
    local new_image=$2
    # Опциональный 3й аргумент: JSON-массив [{"name":..,"value":..}, ...]
    # — env, которые надо upsert-нуть в первый container task-def. Существующие
    # значения заменяются по имени, новые добавляются. Дефолт: пустой массив,
    # поведение функции не меняется (back-compat для archive/broadcast блоков).
    # Используется для KS_ADMIN_USERS в api (KS-2108/KS-2109).
    local extra_env_json="${3:-[]}"
    ensure_jq
    local tmp
    tmp=$(mktemp)
    aws ecs describe-task-definition --task-definition "$family" \
        --query 'taskDefinition' --output json \
        | jq --arg img "$new_image" --argjson extras "$extra_env_json" '
            .containerDefinitions |= map(
              .image = $img
              | (.environment // []) as $cur
              | .environment = (
                  ($cur + $extras)
                  | group_by(.name)
                  | map(.[-1])
                )
            )
            | del(
                .taskDefinitionArn, .revision, .status, .compatibilities,
                .requiresAttributes, .registeredAt, .registeredBy,
                .deregisteredAt, .enableFaultInjection
              )
          ' > "$tmp"
    aws ecs register-task-definition --cli-input-json "file://$tmp" \
        --query 'taskDefinition.taskDefinitionArn' --output text
    rm -f "$tmp"
}

# KS-1897: идемпотентная обёртка над register_new_task_def_with_image.
# Если последний active revision указанной family уже использует целевой image
# (например, повторный запуск deploy на том же SHA), не создаёт лишний revision —
# возвращает ARN существующего. Иначе регистрирует новый и возвращает его ARN.
# Это нужно чтобы дeploy archive-service был идемпотентным по всем
# ARCHIVE_TD_FAMILIES без накопления одинаковых revision'ов.
register_or_get_task_def() {
    local family=$1
    local new_image=$2
    local current_image current_arn
    current_image=$(aws ecs describe-task-definition --task-definition "$family" \
        --query 'taskDefinition.containerDefinitions[0].image' --output text 2>/dev/null || echo "")
    if [ -n "$current_image" ] && [ "$current_image" = "$new_image" ]; then
        current_arn=$(aws ecs describe-task-definition --task-definition "$family" \
            --query 'taskDefinition.taskDefinitionArn' --output text 2>/dev/null || echo "")
        if [ -n "$current_arn" ] && [ "$current_arn" != "None" ]; then
            echo "$current_arn"
            return 0
        fi
    fi
    register_new_task_def_with_image "$family" "$new_image"
}

# KS-1897: переключает target task-def у EventBridge Scheduler на новую revision.
# AWS Scheduler требует полный объект расписания на update-schedule (имя, cron,
# FlexibleTimeWindow, Target). Получаем текущее через get-schedule, заменяем
# Target.EcsParameters.TaskDefinitionArn, чистим read-only поля, отдаём update.
# Идемпотентность: если ARN уже совпадает с целевым — пропускаем вызов.
update_eventbridge_schedule_task_def() {
    local schedule_name=$1
    local new_td_arn=$2
    ensure_jq
    local current_arn
    current_arn=$(aws scheduler get-schedule --name "$schedule_name" \
        --query 'Target.EcsParameters.TaskDefinitionArn' --output text 2>/dev/null || echo "")
    if [ "$current_arn" = "$new_td_arn" ]; then
        echo "  EventBridge $schedule_name already on target revision (no-op)."
        return 0
    fi
    local tmp
    tmp=$(mktemp)
    aws scheduler get-schedule --name "$schedule_name" --output json \
        | jq --arg arn "$new_td_arn" '
            .Target.EcsParameters.TaskDefinitionArn = $arn
            | del(.Arn, .CreationDate, .LastModificationDate)
          ' > "$tmp"
    aws scheduler update-schedule --cli-input-json "file://$tmp" >/dev/null
    rm -f "$tmp"
    echo "  EventBridge $schedule_name → $new_td_arn"
}

# KS-1826: атомарно двигает `:latest` в ECR на manifest указанного тега.
# Вызывается только после того, как ВСЕ gate'ы (migrate + services-stable + smoke)
# этого блока прошли.
#
# KS-2442: поддержка IMMUTABLE-репо. Раньше функция полагалась на
# tagMutability=MUTABLE (put-image перезаписывал существующий :latest).
# kingside-tactic-worker создан как IMMUTABLE (KS-2439 spec) — для него
# put-image на уже занятый :latest падает с TagInvalidParameterException
# / ImageTagAlreadyExistsException и в логах выглядит как «digest mismatch».
# Решение: детектируем mutability репо; для IMMUTABLE сначала удаляем тег
# :latest (deletion на IMMUTABLE разрешена, immutability защищает только
# от overwrite), затем put-image на новый manifest. Образ старого digest
# не теряется — он остаётся в репо под своим pinned :<sha>-тегом.
# Окно без :latest измеряется секундами, на ECS не влияет: task-def держит
# pinned :<sha>, EventBridge target — task-def ARN, adhoc RunTask тоже.
ecr_move_latest_to_tag() {
    local repo=$1
    local src_tag=$2
    local manifest
    manifest=$(aws ecr batch-get-image \
        --repository-name "$repo" \
        --image-ids imageTag="$src_tag" \
        --query 'images[0].imageManifest' --output text)
    if [ -z "$manifest" ] || [ "$manifest" = "None" ]; then
        echo "  ERROR: cannot read manifest of ${repo}:${src_tag} — :latest NOT moved."
        return 1
    fi

    local mutability
    mutability=$(aws ecr describe-repositories \
        --repository-names "$repo" \
        --query 'repositories[0].imageTagMutability' --output text 2>/dev/null || echo "")

    # Идемпотентность: если :latest уже указывает на тот же digest — no-op
    # (для обоих режимов одинаково). Делаем ДО put-image — так избегаем
    # лишнего delete+put на immutable, и более чистого "no-op" лога.
    local latest_digest sha_digest
    latest_digest=$(aws ecr batch-get-image \
        --repository-name "$repo" \
        --image-ids imageTag=latest \
        --query 'images[0].imageId.imageDigest' --output text 2>/dev/null || echo "")
    sha_digest=$(aws ecr batch-get-image \
        --repository-name "$repo" \
        --image-ids imageTag="$src_tag" \
        --query 'images[0].imageId.imageDigest' --output text 2>/dev/null || echo "")
    if [ -n "$latest_digest" ] && [ "$latest_digest" = "$sha_digest" ]; then
        echo "  :latest already points to ${repo}:${src_tag} (no-op)."
        return 0
    fi

    # IMMUTABLE: сначала удаляем существующий тег :latest (если есть), затем put.
    if [ "$mutability" = "IMMUTABLE" ] && [ -n "$latest_digest" ]; then
        aws ecr batch-delete-image \
            --repository-name "$repo" \
            --image-ids imageTag=latest \
            --output text >/dev/null 2>&1 || true
    fi

    if aws ecr put-image \
        --repository-name "$repo" \
        --image-tag latest \
        --image-manifest "$manifest" \
        --output text >/dev/null 2>&1; then
        echo "  :latest → ${repo}:${src_tag} (atomic move${mutability:+, mutability=$mutability})."
    else
        # Перепроверяем: возможно гонка / параллельный deploy уже обновил :latest.
        latest_digest=$(aws ecr batch-get-image \
            --repository-name "$repo" \
            --image-ids imageTag=latest \
            --query 'images[0].imageId.imageDigest' --output text 2>/dev/null || echo "")
        if [ -n "$latest_digest" ] && [ "$latest_digest" = "$sha_digest" ]; then
            echo "  :latest already points to ${repo}:${src_tag} (concurrent move)."
            return 0
        else
            echo "  ERROR: aws ecr put-image failed and :latest is NOT on ${src_tag} (digest mismatch, mutability=${mutability:-unknown})."
            return 1
        fi
    fi
}

detect_deploy_scope() {
    local deployed_commit
    deployed_commit=$(get_deployed_commit)

    if [ -z "$deployed_commit" ]; then
        echo "all"
        return
    fi

    local current_commit
    current_commit=$(git -C "$REPO_DIR" rev-parse HEAD)

    if [ "$deployed_commit" = "$current_commit" ]; then
        echo "none"
        return
    fi

    if ! git -C "$REPO_DIR" cat-file -t "$deployed_commit" &>/dev/null; then
        echo "all"
        return
    fi

    local changed_files
    changed_files=$(git -C "$REPO_DIR" diff --name-only "$deployed_commit"..HEAD)

    local has_frontend=false
    local has_api=false
    local has_game=false
    local has_broadcast_service=false
    local has_archive_service=false
    local has_synthetic_bot=false
    local has_tactic_worker=false

    while IFS= read -r file; do
        [ -z "$file" ] && continue
        case "$file" in
            apps/web/*)
                has_frontend=true ;;
            apps/api/*)
                has_api=true ;;
            apps/game-service/*)
                has_game=true ;;
            apps/broadcast-service/*)
                has_broadcast_service=true ;;
            packages/broadcasts-db/*)
                has_broadcast_service=true ;;
            apps/archive-service/*)
                has_archive_service=true ;;
            packages/archive-db/*)
                has_archive_service=true ;;
            apps/synthetic-bot-service/*)
                has_synthetic_bot=true ;;
            apps/tactic-worker/*)
                has_tactic_worker=true ;;
            packages/shared/*)
                has_frontend=true
                has_api=true
                has_game=true
                has_broadcast_service=true
                has_archive_service=true
                has_synthetic_bot=true
                has_tactic_worker=true ;;
            scripts/*|infra/*|justfile)
                has_frontend=true
                has_api=true
                has_game=true
                has_broadcast_service=true
                has_archive_service=true
                has_synthetic_bot=true
                has_tactic_worker=true ;;
        esac
    done <<< "$changed_files"

    # Multiple services changed → deploy all
    local count=0
    $has_frontend && count=$((count + 1))
    $has_api && count=$((count + 1))
    $has_game && count=$((count + 1))
    $has_broadcast_service && count=$((count + 1))
    $has_archive_service && count=$((count + 1))
    $has_synthetic_bot && count=$((count + 1))
    $has_tactic_worker && count=$((count + 1))

    if [ "$count" -gt 1 ]; then
        echo "all"
    elif $has_frontend; then
        echo "frontend"
    elif $has_api; then
        echo "api"
    elif $has_game; then
        echo "game-service"
    elif $has_broadcast_service; then
        echo "broadcast-service"
    elif $has_archive_service; then
        echo "archive-service"
    elif $has_synthetic_bot; then
        echo "synthetic-bot"
    elif $has_tactic_worker; then
        echo "tactic-worker"
    else
        echo "none"
    fi
}

# --- Main ---

FORCE_SCOPE="${1:-auto}"

fix_symlinks
ensure_deps

# KS-3057: при re-exec через flock-обёртки SCOPE уже зарезолвлен и
# проброшен в env — повторный detect не нужен.
if [ -n "${KINGSIDE_DEPLOY_RESOLVED_SCOPE:-}" ]; then
    SCOPE="$KINGSIDE_DEPLOY_RESOLVED_SCOPE"
    echo "Inherited scope (under lock): $SCOPE"
elif [ "$FORCE_SCOPE" = "auto" ]; then
    SCOPE=$(detect_deploy_scope)
    if [ "$SCOPE" = "none" ]; then
        echo "No changes since last deploy ($(get_deployed_commit | head -c 7)). Nothing to do."
        exit 0
    fi
    echo "Auto-detected scope: $SCOPE"
else
    SCOPE="$FORCE_SCOPE"
    echo "Forced scope: $SCOPE"
fi

# KS-3057: захватываем lock'и ПОСЛЕ резолва scope, чтобы знать какие
# именно per-scope lock'и брать (двухуровневая схема: master shared/
# exclusive + per-scope exclusive). Экспортируем scope для release-trap.
export KINGSIDE_DEPLOY_RESOLVED_SCOPE="$SCOPE"
acquire_deploy_locks "$SCOPE"

DEPLOY_FRONTEND=false
DEPLOY_API=false
DEPLOY_GAME=false
DEPLOY_BROADCAST_SERVICE=false
DEPLOY_ARCHIVE_SERVICE=false
DEPLOY_SYNTHETIC_BOT=false
DEPLOY_TACTIC_WORKER=false

case "$SCOPE" in
    frontend)           DEPLOY_FRONTEND=true ;;
    api)                DEPLOY_API=true ;;
    game-service)       DEPLOY_GAME=true ;;
    broadcast-service)  DEPLOY_BROADCAST_SERVICE=true ;;
    archive-service)    DEPLOY_ARCHIVE_SERVICE=true ;;
    synthetic-bot)      DEPLOY_SYNTHETIC_BOT=true ;;
    tactic-worker)      DEPLOY_TACTIC_WORKER=true ;;
    workers)            DEPLOY_BROADCAST_SERVICE=true; DEPLOY_ARCHIVE_SERVICE=true ;;
    all)                DEPLOY_FRONTEND=true; DEPLOY_API=true; DEPLOY_GAME=true; DEPLOY_BROADCAST_SERVICE=true; DEPLOY_ARCHIVE_SERVICE=true; DEPLOY_SYNTHETIC_BOT=true; DEPLOY_TACTIC_WORKER=true ;;
    *)                  echo "Unknown scope: $SCOPE"; exit 1 ;;
esac

echo ""
echo "=== Deploy Kingside to AWS ($SCOPE) ==="
echo "=== Build tag (KS-1826): $DEPLOY_SHA"
echo ""

# --- Frontend: vite build → S3 sync → CloudFront invalidation ---
# Frontend не использует ECR — атомарность ECR-тегов не применима.
if $DEPLOY_FRONTEND; then
    _perf_stamp "frontend_start"
    # KS-2085 follow-up: чистим vite-cache и старый dist перед сборкой.
    # Без этого Vite иногда переиспользует кэш транзформаций даже при
    # изменении исходников, и asset-hash остаётся прежним, маскируя
    # деплой как успешный (KS-2089 case: archive.css правка не доехала
    # до bundle, hash не сменился).
    echo "[frontend] Clearing vite cache + dist..."
    rm -rf "$REPO_DIR/apps/web/dist" \
           "$REPO_DIR/node_modules/.vite" \
           "$REPO_DIR/apps/web/node_modules/.vite" 2>/dev/null || true

    echo "[frontend] Building (VITE_API_URL=$PROD_VITE_API_URL, VITE_ARCHIVE_URL=$PROD_VITE_ARCHIVE_URL, VITE_BROADCAST_URL=$PROD_VITE_BROADCAST_URL, VITE_APP_ORIGIN=$PROD_API_URL, VITE_GAME_URL=$PROD_GAME_URL, VITE_GA4_ID=$PROD_GA4_ID, VITE_FEATURE_LESSONS=$PROD_VITE_FEATURE_LESSONS)..."
    VITE_API_URL="$PROD_VITE_API_URL" VITE_ARCHIVE_URL="$PROD_VITE_ARCHIVE_URL" VITE_BROADCAST_URL="$PROD_VITE_BROADCAST_URL" VITE_APP_ORIGIN="$PROD_API_URL" VITE_GAME_URL="$PROD_GAME_URL" VITE_GA4_ID="$PROD_GA4_ID" VITE_FEATURE_LESSONS="$PROD_VITE_FEATURE_LESSONS" npm run build --prefix "$REPO_DIR" --workspace=apps/web
    echo "  Built: $REPO_DIR/apps/web/dist"
    _perf_stamp "frontend_vite_build_done"

    echo "[frontend] Syncing to S3..."
    # KS-2918: hash-name'д чанки в /assets/ — immutable. Удалять их сразу после
    # выката нового билда нельзя: активные вкладки клиентов ещё держат
    # dynamic-import'ы на старые hash-чанки → 403 → "Failed to fetch
    # dynamically imported module". Поэтому:
    #   1) корень + не-hash-статика — синкается с --delete (index.html, sw.js,
    #      manifest.webmanifest и т.п. перезаписываются, удалённые из dist
    #      ключи стираются с S3).
    #   2) /assets/ — синкается БЕЗ --delete. Старые hash-чанки остаются на
    #      S3 для уже открытых вкладок. Физическое удаление — через S3
    #      Lifecycle (правило expire-stale-hashed-assets, Expiration 30 days
    #      по prefix=assets/). Vite пересобирает dist на каждом выкате →
    #      mtime локальных файлов всегда свежий → sync обновляет LastModified
    #      у current-чанков → lifecycle countdown сбрасывается. Чанк, чьего
    #      исходника больше нет в коде, через 30 дней (по своему собственному
    #      LastModified) удалится.
    aws s3 sync "$REPO_DIR/apps/web/dist/" "s3://${S3_BUCKET}/" \
        --delete --exclude "assets/*" --quiet
    aws s3 sync "$REPO_DIR/apps/web/dist/assets/" "s3://${S3_BUCKET}/assets/" \
        --quiet
    echo "  Synced to s3://$S3_BUCKET/ (root pruned, assets retained for lifecycle)"
    _perf_stamp "frontend_s3_sync_done"

    echo "[frontend] Invalidating CloudFront cache..."
    aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION" \
        --paths "/*" --query 'Invalidation.Id' --output text
    echo "  CloudFront invalidation created."
    _perf_stamp "frontend_cf_invalidation_done"
fi

# --- API: docker build → ECR push под :<sha> → migrate → update-service →
#         services-stable → put-image :latest (атомарный move) ---
if $DEPLOY_API; then
    _perf_stamp "api_start"
    NEW_IMAGE="${ECR_URI}:${DEPLOY_SHA}"

    echo "[api] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null
    _perf_stamp "api_ecr_login_done"

    echo "[api] Building Docker image (tag=$DEPLOY_SHA)..."
    # KS-2441: --progress=plain + tee в /tmp + извлечение npm error при failure.
    # Раньше при неудачной сборке наружу через MCP-deploy улетали последние ~1KB
    # stderr — там оставалась только npm-help-портянка, реальный `npm error code
    # EUSAGE / Missing X / ...` обрезался слева. С `--progress=plain` весь вывод
    # идёт построчно с префиксом #N <step>, а tee гарантирует полный лог в файле.
    # KS-2441: пишем в /project/logs/, а не /tmp — /project/logs шарится между
    # webhook-сервером и агентским контейнером (devops читает оттуда полный
    # лог сразу после deploy). /tmp у webhook'а изолирован.
    BUILD_LOG="$REPO_DIR/logs/api-build-${DEPLOY_SHA}.log"
    mkdir -p "$REPO_DIR/logs"
    set +e
    docker build --progress=plain -t "kingside-api:${DEPLOY_SHA}" \
        -f "$REPO_DIR/apps/api/Dockerfile" "$REPO_DIR" 2>&1 | tee "$BUILD_LOG"
    BUILD_RC=${PIPESTATUS[0]}
    set -e
    if [ "$BUILD_RC" -ne 0 ]; then
        echo ""
        echo "  ERROR: docker build failed (rc=$BUILD_RC). Full log: $BUILD_LOG"
        echo "  --- npm error context (grep по Missing|Invalid|EUSAGE|peer|Tracker|require) ---"
        grep -E 'npm (error|warn) (code|Missing|Invalid|EUSAGE|peer|require|Tracker)|npm ci' "$BUILD_LOG" \
            | head -120 || true
        echo "  --- last 80 lines of build log ---"
        tail -80 "$BUILD_LOG" || true
        exit "$BUILD_RC"
    fi
    _perf_stamp "api_docker_build_done"

    echo "[api] Pushing ${ECR_REPO_API}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-api:${DEPLOY_SHA}" "$NEW_IMAGE"
    docker push "$NEW_IMAGE" 2>&1 | tail -3
    _perf_stamp "api_docker_push_done"

    echo "[api] Registering new task-def revision with image=:${DEPLOY_SHA}..."
    # KS-2108/KS-2109: admin endpoints (feature flags) требуют список логинов
    # в KS_ADMIN_USERS, default-deny если не задано. Прокидываем через
    # env-overrides, существующая env остаётся как есть.
    # 30.04 откат synthetic-stack (KS-2159..2179): SYNTHETIC_AVATARS_*
    # удалены из API_EXTRA_ENV, чтобы deploy api не возрождал фичу.
    # Bucket/IAM/БД-миграция оставлены до решения о новой архитектуре.
    API_EXTRA_ENV='[{"name":"KS_ADMIN_USERS","value":"Stanislav"}]'
    NEW_TD_ARN=$(register_new_task_def_with_image "$TD_FAMILY_API" "$NEW_IMAGE" "$API_EXTRA_ENV")
    echo "  task-def: $NEW_TD_ARN"
    _perf_stamp "api_taskdef_done"

    # KS-3049 / ADR-045 §5.1: skip migrate run-task если нет pending миграций.
    if should_run_migrate "api" "apps/api/prisma/migrations"; then
        echo "[api] Running Prisma migrations on new revision..."
        ensure_migrate_network
        MIGRATE_TASK=$(aws ecs run-task \
            --cluster "$ECS_CLUSTER" --task-definition "$NEW_TD_ARN" --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[$MIGRATE_SUBNET],securityGroups=[$MIGRATE_SG],assignPublicIp=ENABLED}" \
            --overrides '{"containerOverrides":[{"name":"kingside-api","command":["sh","-c","cd /app/apps/api && npx prisma migrate deploy"]}]}' \
            --query 'tasks[0].taskArn' --output text)
        aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$MIGRATE_TASK"
        MIGRATE_EXIT=$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$MIGRATE_TASK" \
            --query 'tasks[0].containers[0].exitCode' --output text)
        if [ "$MIGRATE_EXIT" != "0" ]; then
            echo "  ERROR: Prisma migrate failed (exit $MIGRATE_EXIT). Aborting deploy."
            echo "  :latest NOT moved — остаётся на предыдущем удачном digest."
            exit 1
        fi
        echo "  Migrations applied."
    else
        echo "[api] migrate skipped, schema up-to-date (KS-3049)"
    fi
    _perf_stamp "api_migrate_done"

    echo "[api] Updating ECS service to new revision..."
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
        --task-definition "$NEW_TD_ARN" \
        --force-new-deployment --query 'service.deployments[0].status' --output text
    echo "  ECS service update initiated."
    _perf_stamp "api_update_service_done"

    echo "[api] Waiting for rollout to stabilize..."
    if ! aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE"; then
        echo "  ERROR: services-stable timed out or failed. :latest NOT moved."
        echo "  Rollback: см. runbook в шапке deploy-aws.sh."
        exit 1
    fi
    echo "  Rollout stable."
    _perf_stamp "api_services_stable_done"

    echo "[api] Atomic move ${ECR_REPO_API}:latest → :${DEPLOY_SHA}..."
    ecr_move_latest_to_tag "$ECR_REPO_API" "$DEPLOY_SHA"
    _perf_stamp "api_atomic_latest_done"
fi

# --- Game Service: docker build → ECR push под :<sha> → update-service →
#                   services-stable → put-image :latest (атомарный move) ---
# Миграций нет (game-service stateless). Smoke пока тоже нет (см. KS-1817 — там
# появился только для broadcast/archive). Gate = services-stable.
if $DEPLOY_GAME; then
    _perf_stamp "game_start"
    NEW_IMAGE="${ECR_URI_GAME}:${DEPLOY_SHA}"

    echo "[game-service] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null
    _perf_stamp "game_ecr_login_done"

    echo "[game-service] Building Docker image (tag=$DEPLOY_SHA)..."
    docker build -t "kingside-game-service:${DEPLOY_SHA}" -f "$REPO_DIR/apps/game-service/Dockerfile" "$REPO_DIR"
    _perf_stamp "game_docker_build_done"

    echo "[game-service] Pushing ${ECR_REPO_GAME}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-game-service:${DEPLOY_SHA}" "$NEW_IMAGE"
    docker push "$NEW_IMAGE" 2>&1 | tail -3
    _perf_stamp "game_docker_push_done"

    echo "[game-service] Registering new task-def revision with image=:${DEPLOY_SHA}..."
    # 30.04 откат synthetic-stack (KS-2159..2179): GAME_SERVICE_EXTRA_ENV
    # удалён, чтобы deploy game-service не возрождал фичу через ENV. Если
    # synthetic будет возвращён по новой архитектуре (WebSocket-bot-fleet),
    # этот блок будет переписан.
    NEW_TD_ARN=$(register_new_task_def_with_image "$TD_FAMILY_GAME" "$NEW_IMAGE")
    echo "  task-def: $NEW_TD_ARN"
    _perf_stamp "game_taskdef_done"

    echo "[game-service] Updating ECS service to new revision..."
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_GAME" \
        --task-definition "$NEW_TD_ARN" \
        --force-new-deployment --query 'service.deployments[0].status' --output text
    echo "  ECS service update initiated."
    _perf_stamp "game_update_service_done"

    echo "[game-service] Waiting for rollout to stabilize..."
    if ! aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_GAME"; then
        echo "  ERROR: services-stable timed out or failed. :latest NOT moved."
        echo "  Rollback: см. runbook в шапке deploy-aws.sh."
        exit 1
    fi
    echo "  Rollout stable."
    _perf_stamp "game_services_stable_done"

    echo "[game-service] Atomic move ${ECR_REPO_GAME}:latest → :${DEPLOY_SHA}..."
    ecr_move_latest_to_tag "$ECR_REPO_GAME" "$DEPLOY_SHA"
    _perf_stamp "game_atomic_latest_done"
fi

# --- Broadcast Service (apps/broadcast-service): docker build → ECR push под :<sha> →
#     migrate → update-service → services-stable → smoke → put-image :latest ---
# ADR-021: REST+WS для /broadcasts переезжает из apps/api в отдельный apps/broadcast-service
# на broadcasts.kingside.site. Образ kingside-broadcast-service обслуживает один ECS-сервис
# kingside-broadcast-service (HTTP+WS на порту 3004). Sticky sessions включены на ALB TG
# kingside-broadcasts-api (lb_cookie, WS-critical).
# Инфра — scripts/broadcast-service-aws-setup.sh (KS-1696).
if $DEPLOY_BROADCAST_SERVICE; then
    _perf_stamp "broadcast_start"
    NEW_IMAGE="${ECR_URI_BROADCAST_SERVICE}:${DEPLOY_SHA}"

    echo "[broadcast-service] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null
    _perf_stamp "broadcast_ecr_login_done"

    echo "[broadcast-service] Building Docker image (tag=$DEPLOY_SHA)..."
    docker build -t "kingside-broadcast-service:${DEPLOY_SHA}" -f "$REPO_DIR/apps/broadcast-service/Dockerfile" "$REPO_DIR"
    _perf_stamp "broadcast_docker_build_done"

    echo "[broadcast-service] Pushing ${ECR_REPO_BROADCAST_SERVICE}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-broadcast-service:${DEPLOY_SHA}" "$NEW_IMAGE"
    docker push "$NEW_IMAGE" 2>&1 | tail -3
    _perf_stamp "broadcast_docker_push_done"

    SVC_STATUS=$(aws ecs describe-services \
        --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_BROADCAST_SERVICE" \
        --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")
    _perf_stamp "broadcast_describe_service_done"

    if [ "$SVC_STATUS" = "ACTIVE" ]; then
        echo "[broadcast-service] Registering new task-def revision with image=:${DEPLOY_SHA}..."
        # KS-2158: BROADCAST_WATCHDOG_ENABLED включает фоновый watchdog для
        # автозакрытия broadcast_rounds, отвалившихся от Lichess. Без 'true'
        # сервис idle. Прокидываем через env-overrides; остальная env остаётся.
        BROADCAST_SERVICE_EXTRA_ENV='[{"name":"BROADCAST_WATCHDOG_ENABLED","value":"true"}]'
        NEW_TD_ARN=$(register_new_task_def_with_image "$TD_FAMILY_BROADCAST_SERVICE" "$NEW_IMAGE" "$BROADCAST_SERVICE_EXTRA_ENV")
        echo "  task-def: $NEW_TD_ARN"
        _perf_stamp "broadcast_taskdef_done"

        # KS-1817: Prisma migrations для broadcasts-db (отдельная БД broadcasts_kingside).
        # До KS-1817 миграции этой БД накатывались вручную → 24.04 миграция 20260424093000
        # не приехала вместе с деплоем KS-1813 и /rounds падал 500.
        # KS-1826: migrate-run-task идёт на НОВУЮ revision (image :<sha>) — прод-сервисы
        # пока продолжают работать на предыдущей revision / предыдущем :latest.
        # KS-3049: skip migrate run-task если нет pending миграций.
        if should_run_migrate "broadcast" "packages/broadcasts-db/prisma/migrations"; then
            echo "[broadcast-service] Running Prisma migrations (broadcasts-db) on new revision..."
            ensure_migrate_network
            MIGRATE_TASK=$(aws ecs run-task \
                --cluster "$ECS_CLUSTER" --task-definition "$NEW_TD_ARN" --launch-type FARGATE \
                --network-configuration "awsvpcConfiguration={subnets=[$MIGRATE_SUBNET],securityGroups=[$MIGRATE_SG],assignPublicIp=ENABLED}" \
                --overrides '{"containerOverrides":[{"name":"kingside-broadcast-service","command":["sh","-c","cd /app/packages/broadcasts-db && npx prisma migrate deploy --schema=./prisma/schema.prisma"]}]}' \
                --query 'tasks[0].taskArn' --output text)
            aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$MIGRATE_TASK"
            MIGRATE_EXIT=$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$MIGRATE_TASK" \
                --query 'tasks[0].containers[0].exitCode' --output text)
            if [ "$MIGRATE_EXIT" != "0" ]; then
                echo "  ERROR: Prisma migrate failed (exit $MIGRATE_EXIT). Aborting deploy."
                echo "  :latest NOT moved — остаётся на предыдущем удачном digest."
                exit 1
            fi
            echo "  Migrations applied."
        else
            echo "[broadcast-service] migrate skipped, schema up-to-date (KS-3049)"
        fi
        _perf_stamp "broadcast_migrate_done"

        echo "[broadcast-service] Updating ECS service to new revision..."
        aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_BROADCAST_SERVICE" \
            --task-definition "$NEW_TD_ARN" \
            --force-new-deployment --query 'service.deployments[0].status' --output text
        echo "  ECS service update initiated."
        _perf_stamp "broadcast_update_service_done"

        # KS-1817: post-deploy smoke-gate. Ждём rollout до stable (max ~10 min),
        # затем curl на реальный broadcast. Если /rounds != 200 — зафейлить деплой,
        # оператор может откатить через update-service --task-definition <prev-rev>.
        # SMOKE_BROADCAST_ID можно переопределить через env, дефолт — 2026 Chess.com Open.
        SMOKE_BROADCAST_ID="${SMOKE_BROADCAST_ID:-f427e6de-10d7-42b9-9aec-58154a92d270}"
        echo "[broadcast-service] Waiting for rollout to stabilize..."
        if ! aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_BROADCAST_SERVICE"; then
            echo "  ERROR: services-stable timed out or failed. :latest NOT moved."
            echo "  Rollback: см. runbook в шапке deploy-aws.sh."
            exit 1
        fi
        _perf_stamp "broadcast_services_stable_done"
        echo "[broadcast-service] Smoke-check /rounds on broadcast $SMOKE_BROADCAST_ID..."
        SMOKE_CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "https://broadcasts.kingside.site/${SMOKE_BROADCAST_ID}/rounds" || echo "000")
        if [ "$SMOKE_CODE" != "200" ]; then
            echo "  ERROR: smoke /rounds returned $SMOKE_CODE (expected 200). Likely DB schema regression or service unavailable."
            echo "  :latest NOT moved — остаётся на предыдущем удачном digest."
            echo "  Rollback: см. runbook в шапке deploy-aws.sh."
            exit 1
        fi
        echo "  Smoke /rounds OK (HTTP 200)."
        _perf_stamp "broadcast_smoke_done"

        echo "[broadcast-service] Atomic move ${ECR_REPO_BROADCAST_SERVICE}:latest → :${DEPLOY_SHA}..."
        ecr_move_latest_to_tag "$ECR_REPO_BROADCAST_SERVICE" "$DEPLOY_SHA"
        _perf_stamp "broadcast_atomic_latest_done"
    else
        echo "[broadcast-service] ECS service '$ECS_SERVICE_BROADCAST_SERVICE' not found (status=$SVC_STATUS)."
        echo "[broadcast-service] Run scripts/broadcast-service-aws-setup.sh after first image push to register task-def + create service."
        echo "[broadcast-service] :latest NOT moved (bootstrap flow)."
    fi
fi

# --- Archive Service (apps/archive-service): docker build → ECR push под :<sha> →
#     register-task-def для всех ARCHIVE_TD_FAMILIES → migrate → update ECS-services →
#     services-stable → smoke → EventBridge update → put-image :latest ---
# ADR-019: единый образ kingside-archive-service.
# ADR-020: importer переведён с continuous ECS-service на EventBridge Schedule.
# KS-1897: на проде используются 3 task-def family с этим образом — все обновляем.
# C-следствие KS-1897: legacy family kingside-archive-importer (без потребителя)
# дерегистрирована, в массив не входит.
#
# Семантика по семействам:
#   - kingside-archive-service           — ECS service (HTTP, /tree). update-service.
#   - kingside-archive-importer-oneshot  — EventBridge daily target. После
#                                          register обновляем target ARN расписания.
#   - kingside-archive-importer-adhoc    — adhoc batch / dev (ручной aws ecs run-task,
#                                          подхватывает свежий :latest). Только register.
if $DEPLOY_ARCHIVE_SERVICE; then
    _perf_stamp "archive_start"
    NEW_IMAGE="${ECR_URI_ARCHIVE_SERVICE}:${DEPLOY_SHA}"

    echo "[archive-service] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null
    _perf_stamp "archive_ecr_login_done"

    echo "[archive-service] Building Docker image (tag=$DEPLOY_SHA)..."
    docker build -t "kingside-archive-service:${DEPLOY_SHA}" -f "$REPO_DIR/apps/archive-service/Dockerfile" "$REPO_DIR"
    _perf_stamp "archive_docker_build_done"

    echo "[archive-service] Pushing ${ECR_REPO_ARCHIVE_SERVICE}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-archive-service:${DEPLOY_SHA}" "$NEW_IMAGE"
    docker push "$NEW_IMAGE" 2>&1 | tail -3
    _perf_stamp "archive_docker_push_done"

    ARCHIVE_SVC_STATUS=$(aws ecs describe-services \
        --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_ARCHIVE_SERVICE" \
        --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")
    ARCHIVE_IMPORTER_STATUS=$(aws ecs describe-services \
        --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_ARCHIVE_IMPORTER" \
        --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")

    # KS-1897: регистрируем новый revision для каждой ARCHIVE_TD_FAMILIES
    # независимо от наличия ECS service у family. ECS update-service ниже
    # запускается только для существующих ACTIVE сервисов — а EventBridge и
    # adhoc просто получают свежий task-def и тянут pinned :<sha>.
    declare -A NEW_TD_ARNS
    for fam in "${ARCHIVE_TD_FAMILIES[@]}"; do
        echo "[archive-service] Registering task-def revision ($fam) with image=:${DEPLOY_SHA}..."
        NEW_TD_ARNS[$fam]=$(register_or_get_task_def "$fam" "$NEW_IMAGE")
        if [ -z "${NEW_TD_ARNS[$fam]}" ] || [ "${NEW_TD_ARNS[$fam]}" = "None" ]; then
            echo "  ERROR: failed to register task-def for $fam. Aborting deploy."
            echo "  :latest NOT moved — остаётся на предыдущем удачном digest."
            exit 1
        fi
        echo "  task-def: ${NEW_TD_ARNS[$fam]}"
    done

    NEW_TD_HTTP_ARN="${NEW_TD_ARNS[$TD_FAMILY_ARCHIVE_SERVICE]}"
    # KS-1897 C-следствие: family kingside-archive-importer дерегистрирована,
    # в массив не входит → ARN пустой. Логика update-service ниже под условием
    # ARCHIVE_IMPORTER_STATUS=ACTIVE никогда не сработает (его и не было), но
    # ветка оставлена для возможного возврата continuous-сервиса в будущем.
    NEW_TD_IMPORTER_ARN="${NEW_TD_ARNS[$TD_FAMILY_ARCHIVE_IMPORTER]:-}"

    if [ "$ARCHIVE_SVC_STATUS" = "ACTIVE" ]; then
        # KS-1822: Prisma migrations для archive-db (отдельная БД archive_kingside,
        # ADR-018). Симметрично api- и broadcast-service-блокам (KS-1817).
        # Одного migrate-таска достаточно: все archive task-def family ездят на
        # одном образе и работают с одной БД (ADR-019).
        # KS-3049: skip migrate run-task если нет pending миграций.
        if should_run_migrate "archive" "packages/archive-db/prisma/migrations"; then
            echo "[archive-service] Running Prisma migrations (archive-db) on new HTTP revision..."
            ensure_migrate_network
            MIGRATE_TASK=$(aws ecs run-task \
                --cluster "$ECS_CLUSTER" --task-definition "$NEW_TD_HTTP_ARN" --launch-type FARGATE \
                --network-configuration "awsvpcConfiguration={subnets=[$MIGRATE_SUBNET],securityGroups=[$MIGRATE_SG],assignPublicIp=ENABLED}" \
                --overrides '{"containerOverrides":[{"name":"kingside-archive-service","command":["sh","-c","cd /app/packages/archive-db && npx prisma migrate deploy --schema=./prisma/schema.prisma"]}]}' \
                --query 'tasks[0].taskArn' --output text)
            aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$MIGRATE_TASK"
            MIGRATE_EXIT=$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$MIGRATE_TASK" \
                --query 'tasks[0].containers[0].exitCode' --output text)
            if [ "$MIGRATE_EXIT" != "0" ]; then
                echo "  ERROR: Prisma migrate failed (exit $MIGRATE_EXIT). Aborting deploy."
                echo "  :latest NOT moved — остаётся на предыдущем удачном digest."
                exit 1
            fi
            echo "  Migrations applied."
        else
            echo "[archive-service] migrate skipped, schema up-to-date (KS-3049)"
        fi
    else
        echo "[archive-service] HTTP service not ACTIVE (status=$ARCHIVE_SVC_STATUS) — skipping migrate step."
    fi

    # Rolling update ECS-сервисов. Сейчас ACTIVE только HTTP-сервис; importer-сервис
    # MISSING после ADR-020 (заменён EventBridge Scheduler). Логика update-service
    # оставлена условной для обратной совместимости — если importer-сервис когда-нибудь
    # вернётся continuous, его revision уже зарегистрирован выше.
    if [ "$ARCHIVE_SVC_STATUS" = "ACTIVE" ]; then
        echo "[archive-service] Updating ECS service $ECS_SERVICE_ARCHIVE_SERVICE to new revision..."
        aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_ARCHIVE_SERVICE" \
            --task-definition "$NEW_TD_HTTP_ARN" \
            --force-new-deployment --query 'service.deployments[0].status' --output text
        echo "  ECS service $ECS_SERVICE_ARCHIVE_SERVICE update initiated."
    else
        echo "[archive-service] ECS service '$ECS_SERVICE_ARCHIVE_SERVICE' not found (status=$ARCHIVE_SVC_STATUS). Skipping."
    fi

    if [ "$ARCHIVE_IMPORTER_STATUS" = "ACTIVE" ]; then
        echo "[archive-service] Updating ECS service $ECS_SERVICE_ARCHIVE_IMPORTER to new revision..."
        aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_ARCHIVE_IMPORTER" \
            --task-definition "$NEW_TD_IMPORTER_ARN" \
            --force-new-deployment --query 'service.deployments[0].status' --output text
        echo "  ECS service $ECS_SERVICE_ARCHIVE_IMPORTER update initiated."
    else
        echo "[archive-service] ECS service '$ECS_SERVICE_ARCHIVE_IMPORTER' not found (status=$ARCHIVE_IMPORTER_STATUS). Skipping update-service."
    fi

    # KS-1822: post-deploy smoke-gate. `GET /tree?fen=<startpos>` реально трогает
    # Prisma-select на position-table, поэтому ловит регрессии схемы (которые
    # /_/health пропускает — тот только `SELECT 1`). FEN стартовой позиции зашит
    # константой, URL-encoded inline (jq нет в ряде окружений деплоя).
    if [ "$ARCHIVE_SVC_STATUS" = "ACTIVE" ]; then
        SMOKE_FEN_ENC="rnbqkbnr%2Fpppppppp%2F8%2F8%2F8%2F8%2FPPPPPPPP%2FRNBQKBNR+w+KQkq+-+0+1"
        echo "[archive-service] Waiting for HTTP rollout to stabilize..."
        if ! aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_ARCHIVE_SERVICE"; then
            echo "  ERROR: services-stable timed out or failed. :latest NOT moved."
            echo "  Rollback: см. runbook в шапке deploy-aws.sh."
            exit 1
        fi
        echo "[archive-service] Smoke-check /tree?fen=<startpos>..."
        SMOKE_CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "https://archive.kingside.site/tree?fen=${SMOKE_FEN_ENC}" || echo "000")
        if [ "$SMOKE_CODE" != "200" ]; then
            echo "  ERROR: smoke /tree returned $SMOKE_CODE (expected 200). Likely DB schema regression or service unavailable."
            echo "  :latest NOT moved — остаётся на предыдущем удачном digest."
            echo "  Rollback: см. runbook в шапке deploy-aws.sh."
            exit 1
        fi
        echo "  Smoke /tree OK (HTTP 200)."
    fi

    # importer — дополнительно ждём стабилизации, чтобы в случае cras-loop
    # свалить деплой до того, как тронем :latest. Smoke для importer нет
    # (нет HTTP endpoint с бизнес-логикой, только /_/health — отдельный lambda
    # путь). services-stable покрывает таск-крэши.
    if [ "$ARCHIVE_IMPORTER_STATUS" = "ACTIVE" ]; then
        echo "[archive-service] Waiting for importer rollout to stabilize..."
        if ! aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_ARCHIVE_IMPORTER"; then
            echo "  ERROR: archive-importer services-stable timed out or failed. :latest NOT moved."
            echo "  Rollback: см. runbook в шапке deploy-aws.sh."
            exit 1
        fi
        echo "  Importer rollout stable."
    fi

    # KS-1897: переключаем EventBridge Scheduler kingside-archive-importer-daily
    # на новый revision oneshot-family. Делается ПОСЛЕ smoke /tree — если HTTP
    # rollout развалился, scheduler остаётся на прежнем revision и завтрашний
    # запуск пойдёт со стабильного образа.
    ONESHOT_NEW_ARN="${NEW_TD_ARNS[kingside-archive-importer-oneshot]:-}"
    if [ -n "$ONESHOT_NEW_ARN" ]; then
        echo "[archive-service] Updating EventBridge Scheduler $ES_SCHEDULE_ARCHIVE_DAILY to new oneshot revision..."
        if ! update_eventbridge_schedule_task_def "$ES_SCHEDULE_ARCHIVE_DAILY" "$ONESHOT_NEW_ARN"; then
            echo "  ERROR: EventBridge update failed. :latest NOT moved."
            echo "  Schedule осталась на прежнем revision; завтрашний запуск пойдёт со старого образа."
            exit 1
        fi
    fi

    # Все gate'ы archive-service'а прошли → атомарно двигаем :latest.
    # Если ни один из двух сервисов не ACTIVE (bootstrap flow), :latest не двигаем.
    if [ "$ARCHIVE_SVC_STATUS" = "ACTIVE" ] || [ "$ARCHIVE_IMPORTER_STATUS" = "ACTIVE" ]; then
        echo "[archive-service] Atomic move ${ECR_REPO_ARCHIVE_SERVICE}:latest → :${DEPLOY_SHA}..."
        ecr_move_latest_to_tag "$ECR_REPO_ARCHIVE_SERVICE" "$DEPLOY_SHA"
    else
        echo "[archive-service] Neither HTTP nor importer ACTIVE — :latest NOT moved (bootstrap flow)."
    fi
    _perf_stamp "archive_done"
fi

# --- Tactic-worker (apps/tactic-worker): docker build → ECR push под :<sha> →
#     register task-def revision с pinned :<sha> → put-image :latest (атомарный move) ---
# KS-2440 / ADR-042 §9.1-§9.2. NestJS standalone CLI, запускается через ECS RunTask
# (drill-индексер, sf-validate, puzzle-генератор). ECS service'а нет — pipeline
# аналогичен archive-importer-adhoc: gate'а services-stable / smoke нет.
# task-def family `kingside-tactic-worker` создан в KS-2439 (revision 1 — bootstrap).
# Если family ещё не зарегистрирован (deploy раньше KS-2439-инфры) — пропускаем
# register и :latest move делаем просто на основе свежепушнутого тега; backend/devops
# дорегистрируют revision вручную после bootstrap.
#
# EventBridge schedule (drill-incremental, KS-2439) пока disabled, его target ARN
# обновлять не нужно. Когда §9.4 включит расписание — добавить сюда вызов
# update_eventbridge_schedule_task_def по аналогии с archive-importer-daily.
if $DEPLOY_TACTIC_WORKER; then
    _perf_stamp "tactic_start"
    NEW_IMAGE="${ECR_URI_TACTIC_WORKER}:${DEPLOY_SHA}"

    echo "[tactic-worker] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null
    _perf_stamp "tactic_ecr_login_done"

    echo "[tactic-worker] Building Docker image (tag=$DEPLOY_SHA)..."
    docker build -t "kingside-tactic-worker:${DEPLOY_SHA}" -f "$REPO_DIR/apps/tactic-worker/Dockerfile" "$REPO_DIR"
    _perf_stamp "tactic_docker_build_done"

    echo "[tactic-worker] Pushing ${ECR_REPO_TACTIC_WORKER}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-tactic-worker:${DEPLOY_SHA}" "$NEW_IMAGE"
    docker push "$NEW_IMAGE" 2>&1 | tail -3
    _perf_stamp "tactic_docker_push_done"

    # Регистрируем новую revision task-def, если family существует. Pinned :<sha>
    # даёт чистый откат и гарантирует что adhoc RunTask тянет проверенный образ
    # даже если :latest развалится.
    TW_TD_STATUS=$(aws ecs describe-task-definition --task-definition "$TD_FAMILY_TACTIC_WORKER" \
        --query 'taskDefinition.status' --output text 2>/dev/null || echo "MISSING")
    if [ "$TW_TD_STATUS" = "ACTIVE" ]; then
        echo "[tactic-worker] Registering new task-def revision with image=:${DEPLOY_SHA}..."
        NEW_TD_ARN=$(register_or_get_task_def "$TD_FAMILY_TACTIC_WORKER" "$NEW_IMAGE")
        if [ -z "$NEW_TD_ARN" ] || [ "$NEW_TD_ARN" = "None" ]; then
            echo "  ERROR: failed to register task-def for $TD_FAMILY_TACTIC_WORKER. Aborting deploy."
            echo "  :latest NOT moved — остаётся на предыдущем удачном digest."
            exit 1
        fi
        echo "  task-def: $NEW_TD_ARN"
    else
        echo "[tactic-worker] task-def family '$TD_FAMILY_TACTIC_WORKER' not registered yet (status=$TW_TD_STATUS)."
        echo "[tactic-worker] First-image bootstrap: skip register-task-def. Run KS-2439 setup to create revision 1 from this image."
    fi

    # Атомарный move :latest. Для tactic-worker это безопасно сразу после push:
    # gate'а services-stable нет (не сервис), а smoke (RunTask с
    # `index-tactic-drills --max-games=1`) делает backend пост-деплой по acceptance KS-2439.
    echo "[tactic-worker] Atomic move ${ECR_REPO_TACTIC_WORKER}:latest → :${DEPLOY_SHA}..."
    ecr_move_latest_to_tag "$ECR_REPO_TACTIC_WORKER" "$DEPLOY_SHA"
    _perf_stamp "tactic_atomic_latest_done"
fi

# --- Synthetic-bot service (apps/synthetic-bot-service) ---
# KS-2195 / ADR-034-v2. Делегируем в scripts/deploy-synthetic-bot.sh — он
# собирает образ, регистрирует новый task-def revision с pinned SHA, делает
# update-service и ждёт services-stable. Атомарный move :latest → :<sha>
# выполняется внутри deploy-synthetic-bot.sh после wait services-stable
# (тот же паттерн KS-1826/KS-2086).
if $DEPLOY_SYNTHETIC_BOT; then
    _perf_stamp "synthetic_start"
    echo ""
    echo "[synthetic-bot] Delegating to scripts/deploy-synthetic-bot.sh..."
    bash "${SCRIPT_DIR}/deploy-synthetic-bot.sh"
    _perf_stamp "synthetic_done"
fi

# Save deployed commit
save_deployed_commit
_perf_stamp "99_deploy_complete"

echo ""
echo "=== Deploy complete ($SCOPE) ==="
_perf_summary
