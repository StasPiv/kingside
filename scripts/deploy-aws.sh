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
DEPLOY_SCOPES_WITH_PER_LOCK=(frontend api game-service broadcast-service archive-service tactic-worker synthetic-bot prerender-service)

# Файл per-scope lock'а для конкретного scope.
deploy_scope_lock_file() {
    echo "$REPO_DIR/.deploy.${1}.lock"
}

# Описание holder'а: читаем метаданные из lock-файла + вычисляем возраст.
# Аргументы: $1 — путь к lock-файлу, $2 — префикс лога ("master" / "scope/api").
#
# KS-4341/KS-4354: добавлен детект «реально ли занят lock». flock(2) — это
# advisory lock на fd, ядро освобождает его при смерти flock-parent
# автоматически. Файл-метаданные после crash может остаться пустым или с
# мёртвым PID — это НЕ блокировка, просто визуальный мусор. Если probe
# в acquire_deploy_locks выдал «busy», но holder PID мёртв или файл пуст —
# реальная проблема НЕ в lock-файле (значит другой живой процесс держит
# fd, race на старте). Печатаем явно, чтобы не вводить читателя в
# заблуждение.
_deploy_lock_print_holder() {
    local lock_file="$1"
    local label="$2"
    local holder_info lock_mtime now age holder_pid pid_status file_size
    holder_info="$(cat "$lock_file" 2>/dev/null || echo '<no metadata>')"
    if ! lock_mtime=$(stat -c '%Y' "$lock_file" 2>/dev/null); then
        lock_mtime=$(stat -f '%m' "$lock_file" 2>/dev/null || echo 0)
    fi
    if ! file_size=$(stat -c '%s' "$lock_file" 2>/dev/null); then
        file_size=$(stat -f '%z' "$lock_file" 2>/dev/null || echo 0)
    fi
    now=$(date +%s)
    age=$((now - lock_mtime))
    echo "[deploy-lock $label] Holder metadata:" >&2
    echo "$holder_info" | sed 's/^/  /' >&2
    echo "[deploy-lock $label] Lock age: ${age}s" >&2

    # Извлекаем PID из метаданных и проверяем — жив ли процесс.
    holder_pid=$(echo "$holder_info" | grep -oE '^pid=[0-9]+' | head -1 | cut -d= -f2)
    if [ "$file_size" = "0" ]; then
        echo "[deploy-lock $label] DIAG: lock file is EMPTY — previous holder crashed before writing metadata." >&2
        echo "[deploy-lock $label] DIAG: flock(2) on fd is the real lock; file content is informational only." >&2
        pid_status="empty-file"
    elif [ -n "$holder_pid" ]; then
        if kill -0 "$holder_pid" 2>/dev/null; then
            echo "[deploy-lock $label] DIAG: holder PID $holder_pid is ALIVE — real deploy in progress." >&2
            pid_status="alive"
        else
            echo "[deploy-lock $label] DIAG: holder PID $holder_pid is DEAD — flock(2) on file is already released by kernel." >&2
            echo "[deploy-lock $label] DIAG: if probe still fails, another (live) process is mid-acquire (race), retry in a moment." >&2
            pid_status="dead"
        fi
    else
        echo "[deploy-lock $label] DIAG: no parseable pid= line in metadata; cannot verify holder liveness." >&2
        pid_status="unparseable"
    fi

    if [ "$age" -gt "$DEPLOY_LOCK_STALE_WARN_SEC" ]; then
        echo "[deploy-lock $label] WARN: lock is older than ${DEPLOY_LOCK_STALE_WARN_SEC}s." >&2
        if [ "$pid_status" = "alive" ]; then
            echo "[deploy-lock $label] WARN: holder may be hung — check what PID $holder_pid is doing." >&2
        fi
    fi
    if [ "$pid_status" = "alive" ]; then
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
        # KS-4341/KS-4354: атомарная запись метаданных. Старый вариант
        # `: > file; echo ... >> file` оставлял окно: если процесс убит
        # между truncate и финальным append (SIGKILL, OOM, MCP-wrapper
        # таймаут), файл остаётся пустым или полупустым. flock(2) сам
        # освобождается ядром, но визуально файл «как будто заблокирован
        # мёртвым PID» вводит читателя в заблуждение.
        # Через mktemp+mv `mv` атомарен в пределах одной FS (renameat2):
        # либо старое содержимое, либо полное новое — никакого окна.
        local _meta_tmp
        _meta_tmp="$(mktemp "${primary_lock_file}.XXXXXX")"
        {
            echo "pid=$$"
            echo "scope=$scope"
            echo "agent=${AGENT_NAME:-${USER:-unknown}}"
            echo "started_at=$(date -Iseconds 2>/dev/null || date)"
            echo "started_unix=$(date +%s)"
            echo "host=$(hostname 2>/dev/null || echo unknown)"
        } > "$_meta_tmp"
        mv -f "$_meta_tmp" "$primary_lock_file"
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
# KS-4194 / ADR-128 §7.3: SEO prerender-service — SQS-воркер на Playwright, S3 backstore.
# Один ECS Fargate task в kingside-prerender-service (desiredCount=1, §7.3.5). Миграций
# нет (нет БД), pipeline аналогичен game-service: build → push :<sha> → register task-def
# revision → update-service → wait stable → atomic :latest.
ECR_URI_PRERENDER_SERVICE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-prerender-service"
# KS-3924: отдельный ECR-repo для лёгкого migration-образа api. Содержит
# node:20-slim + prisma CLI + packages/db/prisma. Используется только для
# pre-rollout `prisma migrate deploy` через Fargate run-task (см. ниже).
# Production-образ kingside-api сам по себе после KS-3924 не содержит prisma
# CLI / @prisma/engines — экономия ~170 МБ в распакованном виде.
ECR_URI_API_MIGRATIONS="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-api-migrations"
# KS-3925: тот же паттерн для archive-service и broadcast-service. Отдельные
# migration-образы содержат packages/archive-db/prisma и packages/broadcasts-db/prisma
# соответственно. Production-образы archive/broadcast после KS-3925 не содержат
# prisma CLI / @prisma/engines — даёт экономию ~30-60 МБ сжатых на каждый.
ECR_URI_ARCHIVE_MIGRATIONS="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-archive-service-migrations"
ECR_URI_BROADCAST_MIGRATIONS="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-broadcast-service-migrations"
# Короткие имена ECR-repo для aws ecr put-image / batch-get-image.
ECR_REPO_API="kingside-api"
ECR_REPO_API_MIGRATIONS="kingside-api-migrations"  # KS-3924
ECR_REPO_GAME="kingside-game-service"
ECR_REPO_BROADCAST_SERVICE="kingside-broadcast-service"
ECR_REPO_BROADCAST_MIGRATIONS="kingside-broadcast-service-migrations"  # KS-3925
ECR_REPO_ARCHIVE_SERVICE="kingside-archive-service"
ECR_REPO_ARCHIVE_MIGRATIONS="kingside-archive-service-migrations"  # KS-3925
ECR_REPO_TACTIC_WORKER="kingside-tactic-worker"
ECR_REPO_PRERENDER_SERVICE="kingside-prerender-service"  # KS-4194
S3_BUCKET="kingside-frontend-${ACCOUNT_ID}"
CF_DISTRIBUTION="E1ECCUC177NSGI"
ECS_CLUSTER="kingside"
ECS_SERVICE="kingside-api"
ECS_SERVICE_GAME="kingside-game-service"
# Task-def families (ECS task-definition name, не ECS-service).
TD_FAMILY_API="kingside-api"
# KS-3924: отдельный task-def family для pre-rollout миграций. Bootstrap-ится
# идемпотентно из kingside-api на первом запуске (см. ensure_migrate_task_def_family),
# дальше каждый деплой регистрирует новую revision с обновлённым migration-образом.
# Контейнер исполняет ENTRYPOINT migration-образа (`npx prisma migrate deploy`),
# DATABASE_URL/secrets берутся из унаследованной от kingside-api environment.
TD_FAMILY_API_MIGRATE="kingside-api-migrate"
TD_FAMILY_GAME="kingside-game-service"
TD_FAMILY_BROADCAST_SERVICE="kingside-broadcast-service"
# KS-3925: migrate task-def family для broadcast-service. Клонируется с
# kingside-broadcast-service на каждом деплое (BROADCASTS_DATABASE_URL и secrets
# берутся из его env).
TD_FAMILY_BROADCAST_MIGRATE="kingside-broadcast-service-migrate"
TD_FAMILY_ARCHIVE_SERVICE="kingside-archive-service"
# KS-3925: migrate task-def family для archive-service. Клонируется с
# kingside-archive-service на каждом деплое (ARCHIVE_DATABASE_URL и secrets
# берутся из его env). Одна migrate-family на все три ARCHIVE_TD_FAMILIES —
# БД одна (archive_kingside, ADR-018/019).
TD_FAMILY_ARCHIVE_MIGRATE="kingside-archive-service-migrate"
TD_FAMILY_ARCHIVE_IMPORTER="kingside-archive-importer"
# KS-2440: task-def family для tactic-worker. Один family на все subcommand'ы
# (index-tactic-drills / sf-validate / generate-puzzles), реальная команда
# передаётся через containerOverrides при RunTask.
TD_FAMILY_TACTIC_WORKER="kingside-tactic-worker"
# KS-4194: task-def family для prerender-service (Fargate, desiredCount=1).
TD_FAMILY_PRERENDER_SERVICE="kingside-prerender-service"
ECS_SERVICE_PRERENDER_SERVICE="kingside-prerender-service"
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
# KS-3817: предварительная фильтрация факторов в buildSnapshotFactors (KS-3815).
# TOP_N и MIN_ABS оставлены дефолтными во фронте — не пробрасываем, чтобы
# не зашивать значения в build-команду.
PROD_VITE_AI_SUBTERM_PREFILTER="1"
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

    # KS-3719: разбивка docker build по шагам и docker push по слоям, если
    # соответствующие *-build-${DEPLOY_SHA}.log / *-push-${DEPLOY_SHA}.log
    # файлы существуют. Логи создаются прокидыванием stdin docker-команд
    # через _with_ts, который префиксует каждую строку секундами от старта.
    if [ -n "${DEPLOY_SHA:-}" ] && [ -d "$REPO_DIR/logs" ]; then
        for blog in "$REPO_DIR/logs/"*-build-"${DEPLOY_SHA}.log"; do
            [ -f "$blog" ] || continue
            local svc
            svc="$(basename "$blog" | sed -E "s/-build-${DEPLOY_SHA}\.log$//")"
            echo ""
            echo "--- docker build steps (${svc}) ---"
            _parse_build_steps "$blog"
        done
        for plog in "$REPO_DIR/logs/"*-push-"${DEPLOY_SHA}.log"; do
            [ -f "$plog" ] || continue
            local svc
            svc="$(basename "$plog" | sed -E "s/-push-${DEPLOY_SHA}\.log$//")"
            echo ""
            echo "--- docker push layers (${svc}) ---"
            _parse_push_layers "$plog"
        done
    fi
    echo "====================================="
}

# KS-3719: префиксует каждую строку stdin десятичными секундами от старта pipe
# в формате `[NNNN.NNN] <line>`. Используется в pipe между `docker build|push`
# и `tee`, чтобы зафиксировать тайминги шагов/слоёв в build/push логах.
# Реализация — perl с Time::HiRes (на любой Debian/Ubuntu хосте есть; ts
# из moreutils не гарантирован).
_with_ts() {
    perl -e '
        use Time::HiRes qw(time);
        $| = 1;
        my $s = time();
        while (defined(my $line = <STDIN>)) {
            printf("[%9.3f] %s", time()-$s, $line);
        }
    '
}

# KS-3719: парсер build-лога с --progress=plain, обработанного через _with_ts.
# Поддерживает оба формата вывода:
#  1) Classic docker builder:
#       [   12.345] Step 6/24 : RUN apt-get install ...
#     Длительность шага = delta до следующей `Step` или до `Successfully built`.
#  2) BuildKit / buildx:
#       [    1.234] #6 [build 3/15] RUN apt-get install ...
#       [   12.345] #6 DONE 11.1s
#       [   12.346] #7 CACHED
#     Длительность берётся напрямую из строки DONE/CACHED, описание — из первого
#     появления `#N ...`. CACHED показывается как 0.00s.
# Сортирует по убыванию длительности — видно что съело время.
_parse_build_steps() {
    local log="$1"
    [ -f "$log" ] || return 0
    perl -e '
        my @rows;
        # classic builder state
        my ($prev_t, $prev_step, $prev_cmd);
        # buildkit state: %desc{step} = command description (из первого появления)
        my %desc;
        my $any_bk;
        open(my $fh, "<", $ARGV[0]) or die "open $ARGV[0]: $!";
        while (my $line = <$fh>) {
            # BuildKit: `#6 DONE 11.1s` или `#7 CACHED`
            if ($line =~ /^\[\s*[\d.]+\] #(\d+)\s+DONE\s+([\d.]+)s/) {
                my ($step, $dur) = ($1, $2);
                push @rows, [$dur + 0, $step, ($desc{$step} // "(?)")];
                $any_bk = 1;
                next;
            }
            if ($line =~ /^\[\s*[\d.]+\] #(\d+)\s+CACHED/) {
                my $step = $1;
                push @rows, [0.0, $step, ($desc{$step} // "(?)") . " [CACHED]"];
                $any_bk = 1;
                next;
            }
            # BuildKit: `#6 [build 3/15] RUN apt-get install ...` — описание
            if ($line =~ /^\[\s*[\d.]+\] #(\d+)\s+(.+)$/) {
                my ($step, $rest) = ($1, $2);
                chomp $rest;
                # пропускаем технические строки: transferring, sha256:, naming to,
                # exporting, writing, resolve, transferring context и т.п.
                next if $rest =~ /^(transferring|sha256:|naming to|exporting|writing|resolve|extracting|naming|preparing)/;
                next if $rest =~ /^\d+(\.\d+)?B?\s/;  # размеры (123.4kB ...)
                # запоминаем только первое содержательное описание шага
                $desc{$step} //= $rest;
                next;
            }
            # Classic builder: `Step 6/24 : RUN apt-get install ...`
            if ($line =~ /^\[\s*([\d.]+)\] Step (\d+)\/\d+ : (.*)$/) {
                my ($t, $step, $cmd) = ($1, $2, $3);
                chomp $cmd;
                if (defined $prev_t) {
                    push @rows, [$t - $prev_t, $prev_step, $prev_cmd];
                }
                ($prev_t, $prev_step, $prev_cmd) = ($t, $step, $cmd);
                next;
            }
            if ($line =~ /^\[\s*([\d.]+)\] Successfully built/) {
                if (defined $prev_t) {
                    push @rows, [$1 - $prev_t, $prev_step, $prev_cmd];
                    undef $prev_t;
                }
                next;
            }
        }
        close $fh;
        unless (@rows) {
            print "    (no build steps detected — лог пуст либо неожиданный формат)\n";
            return;
        }
        @rows = sort { $b->[0] <=> $a->[0] } @rows;
        for my $r (@rows) {
            my $cmd = $r->[2];
            $cmd = substr($cmd, 0, 67) . "..." if length($cmd) > 70;
            printf("    %7.2fs  #%-3s %s\n", $r->[0], $r->[1], $cmd);
        }
    ' "$log"
}

# KS-3719: парсер push-лога docker push, обработанного через _with_ts.
# Для каждого слоя считает время от первой строки `<id>: Preparing|Pushing|Waiting`
# до терминальной `<id>: Pushed|Layer already exists|Mounted from`.
# Выводит по убыванию длительности — видно какие слои реально уходили в сеть
# и какие были cached.
_parse_push_layers() {
    local log="$1"
    [ -f "$log" ] || return 0
    perl -e '
        my %start;
        my @rows;
        open(my $fh, "<", $ARGV[0]) or die "open $ARGV[0]: $!";
        while (my $line = <$fh>) {
            next unless $line =~ /^\[\s*([\d.]+)\] ([0-9a-f]{8,16}):\s+(Preparing|Pushing|Waiting|Pushed|Layer already exists|Mounted from)/;
            my ($t, $id, $st) = ($1, $2, $3);
            $start{$id} = $t unless exists $start{$id};
            if ($st eq "Pushed" || $st eq "Layer already exists" || $st eq "Mounted from") {
                my $status = $st eq "Pushed" ? "uploaded" : ($st eq "Mounted from" ? "mounted" : "cached");
                push @rows, [$t - $start{$id}, $status, $id];
                delete $start{$id};
            }
        }
        close $fh;
        @rows = sort { $b->[0] <=> $a->[0] } @rows;
        for my $r (@rows) {
            printf("    %7.2fs  %-8s  %s\n", $r->[0], $r->[1], $r->[2]);
        }
    ' "$log"
}

# KS-3121/3122/3123 откачены (валили агентские контейнеры на shared-хосте):
#   - DOCKER_BUILDKIT=1 / inline cache (KS-3121) включил buildkitd-демон, который
#     не уважает --memory лимит docker build на уровне процесса. Жрал 10-15G RAM
#     + IO, агенты в swap thrashing.
#   - --memory=6g --memory-swap=6g + nice/ionice (KS-3122/3123) применяются к
#     RUN-контейнерам сборки, но не к самому buildkitd-демону. Защита фиктивна.
# До нахождения способа собирать api НЕ на shared-хосте (CodeBuild/GHA — задача
# KS-3121) используется classic docker builder без лимитов и без cache-from.

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
# KS-3474: skip migrate УБРАН — всегда запускаем `prisma migrate deploy`
# =====================================================================
# Раньше (KS-3049 / ADR-045 §5.1) skip-логика сравнивала HEAD с
# `.deploy-commit-aws`: если SHA не менялся между деплоями — `prisma
# migrate deploy` пропускался. Идея была экономить 60–90 с Fargate
# run-task на warm-деплоях.
#
# Корень проблемы (всплыл в KS-3467, миграция
# `20260530160000_ks3467_repertoire_archive_position_source` не
# применилась, archive_game_id отсутствовала на проде, миграцию
# пришлось накатывать вручную через `aws ecs run-task`):
#
#  1) `.deploy-commit-aws` — ОДИН файл на ВСЕ deploy-scope (frontend / api
#     / broadcast / archive). save_deployed_commit пишет HEAD в конце ЛЮБОГО
#     успешного деплоя. Сценарий KS-3467:
#       a. `deploy frontend` (или иной scope) на коммите X завершился →
#          `.deploy-commit-aws = X`.
#       b. Backend запускает `deploy api` на ТОМ ЖЕ X (в нём миграция).
#       c. should_run_migrate "api" читает last_sha = X, current_sha = X
#          → «HEAD unchanged → skip migrate». Хотя api migrate на этот
#          коммит ни разу не выполнялся.
#     То есть state не персональный для scope, а общий — фронт-деплой
#     «маскирует» pending миграцию для последующего api-деплоя.
#
#  2) Комментарий ниже обещал фоллбэк через api docker-entrypoint
#     (`prisma migrate deploy` на старте контейнера). По факту проверка
#     логов старта kingside-api:332 (KS-3467) показала: entrypoint только
#     тянет ML-модели и сразу `Starting API...`. Никакого migrate deploy
#     в entrypoint нет — фоллбэк не существует.
#
# Решение: всегда запускать `prisma migrate deploy`. Команда идемпотентна
# на стороне Prisma: при отсутствии pending миграций отрабатывает быстро
# («No pending migrations to apply.»). Стоимость — +60–90 с Fargate run-task
# (image pull + lifecycle) на каждый api/broadcast/archive деплой. Это
# приемлемо: молчаливая неприменённая миграция приводит к недоступности
# фич и ручному вмешательству, что значительно дороже.
#
# KS-3491: после KS-3474 ветка «missing migrations dir → skip» оказалась
# ошибочной — `apps/api/prisma/migrations` физически отсутствует (миграции
# уехали в `packages/db/prisma/migrations` по KS-1550), и api тихо
# скипался. Теперь и эта ветка возвращает 0 (run): любая неуверенность →
# запускаем migrate. Дополнительно поправлен путь в call site для api.
#
# Возврат: всегда 0 (run). Аргумент $migrations_path используется только
# для информативного лога — функционально на решение не влияет.
#
# Аргументы:
#   $1 — label сервиса (для лога), например "api" / "broadcast" / "archive"
#   $2 — относительный путь к папке миграций (используется только для
#        sanity-проверки существования директории)
should_run_migrate() {
    # KS-3491: safe-default — если переданный $migrations_path отсутствует
    # локально (например, путь устарел из-за переезда миграций между
    # пакетами), всё равно ЗАПУСКАЕМ migrate. Это в духе всей этой функции:
    # любая неуверенность → run, а не skip. Молчаливый пропуск миграций —
    # самый опасный режим (см. KS-3467, KS-3485). До KS-3474 здесь стоял
    # return 0; в правке KS-3474 я ошибочно перевернул на return 1, и api
    # с устаревшим путём `apps/api/prisma/migrations` (миграции уехали в
    # packages/db/prisma/migrations по KS-1550) тихо скипался — отсюда
    # симптом KS-3485.
    local svc_label="$1"
    local migrations_path="$2"
    if [ -n "$migrations_path" ] && [ ! -d "$REPO_DIR/$migrations_path" ]; then
        echo "[migrate-check $svc_label] migrations dir '$migrations_path' missing → run migrate (safe default, KS-3491)"
        return 0
    fi
    echo "[migrate-check $svc_label] always run migrate (KS-3474: skip removed)"
    return 0
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

# KS-3924: идемпотентное создание ECR-repository. Используется для
# kingside-api-migrations при первом деплое после внедрения migration-образа.
# Существующие репозитории трогать не нужно — RepositoryAlreadyExistsException
# проглатывается, exit code не меняется.
ensure_ecr_repo() {
    local repo_name=$1
    if aws ecr describe-repositories --repository-names "$repo_name" \
            --query 'repositories[0].repositoryName' --output text 2>/dev/null \
            | grep -qx "$repo_name"; then
        return 0
    fi
    echo "[ecr] Creating repository $repo_name..."
    aws ecr create-repository --repository-name "$repo_name" \
        --image-tag-mutability MUTABLE \
        --image-scanning-configuration scanOnPush=false \
        --query 'repository.repositoryArn' --output text
}

# KS-3924: регистрирует новую revision task-def family для migration-образа,
# клонируя текущую активную revision исходного family (kingside-api production).
# Так env/secrets/DATABASE_URL/IAM-роли всегда остаются в синхроне с production —
# любые правки kingside-api автоматически подтягиваются в migrate family на
# ближайшем деплое. Меняются только .family и .containerDefinitions[].image.
# healthCheck из production-образа в migration-контейнере не сработает
# (контейнер выходит после `prisma migrate deploy`), но run-task оценивает
# только exit code, так что это нейтрально.
#
# KS-3925: дополнительно сбрасываем .command, .entryPoint и .healthCheck на
# каждом containerDefinition. Production task-def archive/broadcast-service
# содержит явный `command` (стартовый CMD сервиса), который перебивает
# ENTRYPOINT migration-образа — migrate не запустится, контейнер пойдёт в
# main.js production-логики. Сброс делает поведение универсальным для всех
# трёх migrate-family (api/archive/broadcast): ENTRYPOINT migration-образа
# (`npx prisma migrate deploy`) гарантированно отрабатывает. У api command
# был null, для него сброс — no-op.
register_migrate_task_def_revision() {
    local mig_family=$1
    local src_family=$2
    local new_image=$3
    ensure_jq
    local tmp
    tmp=$(mktemp)
    aws ecs describe-task-definition --task-definition "$src_family" \
        --query 'taskDefinition' --output json \
        | jq --arg fam "$mig_family" --arg img "$new_image" '
            .family = $fam
            | .containerDefinitions |= map(
                .image = $img
                | del(.command, .entryPoint, .healthCheck)
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
    local has_prerender_service=false

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
            apps/prerender-service/*)
                has_prerender_service=true ;;
            packages/shared/*)
                has_frontend=true
                has_api=true
                has_game=true
                has_broadcast_service=true
                has_archive_service=true
                has_synthetic_bot=true
                has_tactic_worker=true
                has_prerender_service=true ;;
            scripts/*|infra/*|justfile)
                has_frontend=true
                has_api=true
                has_game=true
                has_broadcast_service=true
                has_archive_service=true
                has_synthetic_bot=true
                has_tactic_worker=true
                has_prerender_service=true ;;
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
    $has_prerender_service && count=$((count + 1))

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
    elif $has_prerender_service; then
        echo "prerender-service"
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
DEPLOY_PRERENDER_SERVICE=false

case "$SCOPE" in
    frontend)           DEPLOY_FRONTEND=true ;;
    api)                DEPLOY_API=true ;;
    game-service)       DEPLOY_GAME=true ;;
    broadcast-service)  DEPLOY_BROADCAST_SERVICE=true ;;
    archive-service)    DEPLOY_ARCHIVE_SERVICE=true ;;
    synthetic-bot)      DEPLOY_SYNTHETIC_BOT=true ;;
    tactic-worker)      DEPLOY_TACTIC_WORKER=true ;;
    prerender-service)  DEPLOY_PRERENDER_SERVICE=true ;;
    workers)            DEPLOY_BROADCAST_SERVICE=true; DEPLOY_ARCHIVE_SERVICE=true ;;
    all)                DEPLOY_FRONTEND=true; DEPLOY_API=true; DEPLOY_GAME=true; DEPLOY_BROADCAST_SERVICE=true; DEPLOY_ARCHIVE_SERVICE=true; DEPLOY_SYNTHETIC_BOT=true; DEPLOY_TACTIC_WORKER=true; DEPLOY_PRERENDER_SERVICE=true ;;
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

    # KS-4101: фронтовый deploy раньше собирал ТОЛЬКО apps/web (vite) и не
    # билдил workspace-зависимости. После KS-4096 apps/web импортирует
    # '@kingside/maia-core/browser', а dist пакетов в git не коммитится
    # (Rule 7) → без сборки пакета vite не резолвит entry. Собираем ВСЕ
    # зависимости apps/web через turbo (build: dependsOn ^build, outputs
    # dist/**) ПЕРЕД vite. Фильтр '@kingside/web^...' = только зависимости
    # web (maia-core, shared, …), сам apps/web собирает vite ниже.
    echo "[frontend] Building workspace deps (turbo: maia-core, shared, …) before vite..."
    ( cd "$REPO_DIR" && npx --no-install turbo run build --filter='@kingside/web^...' ) \
        || { echo "[frontend] ERROR: workspace deps build (turbo) failed"; exit 1; }

    echo "[frontend] Building (VITE_API_URL=$PROD_VITE_API_URL, VITE_ARCHIVE_URL=$PROD_VITE_ARCHIVE_URL, VITE_BROADCAST_URL=$PROD_VITE_BROADCAST_URL, VITE_APP_ORIGIN=$PROD_API_URL, VITE_GAME_URL=$PROD_GAME_URL, VITE_GA4_ID=$PROD_GA4_ID, VITE_FEATURE_LESSONS=$PROD_VITE_FEATURE_LESSONS, VITE_AI_SUBTERM_PREFILTER=$PROD_VITE_AI_SUBTERM_PREFILTER)..."
    VITE_API_URL="$PROD_VITE_API_URL" VITE_ARCHIVE_URL="$PROD_VITE_ARCHIVE_URL" VITE_BROADCAST_URL="$PROD_VITE_BROADCAST_URL" VITE_APP_ORIGIN="$PROD_API_URL" VITE_GAME_URL="$PROD_GAME_URL" VITE_GA4_ID="$PROD_GA4_ID" VITE_FEATURE_LESSONS="$PROD_VITE_FEATURE_LESSONS" VITE_AI_SUBTERM_PREFILTER="$PROD_VITE_AI_SUBTERM_PREFILTER" npm run build --prefix "$REPO_DIR" --workspace=apps/web
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

    # KS-4404 / ADR-137. `apps/web/dist/blog-sitemap-data.json`
    # генерируется фронтом при vite build (KS-4403). Этот же файл нужен
    # backend (api) для сборки `sitemap-blog.xml` через
    # `SitemapScheduler` (KS-4402). Backend читает его из bucket
    # `kingside-prerender-store`, ключ — `blog-sitemap-data.json`.
    # Frontend-sync выше кладёт файл только в frontend-bucket
    # ($S3_BUCKET), на api он не виден. Добавляем явный `s3 cp` в
    # prerender-store, чтобы blog-sitemap всегда был согласован с
    # выкатанным фронт-индексом блога.
    BLOG_SITEMAP_SRC="$REPO_DIR/apps/web/dist/blog-sitemap-data.json"
    BLOG_SITEMAP_DST="s3://kingside-prerender-store/blog-sitemap-data.json"
    if [ -f "$BLOG_SITEMAP_SRC" ]; then
        echo "[frontend] Publishing blog-sitemap-data.json → $BLOG_SITEMAP_DST..."
        aws s3 cp "$BLOG_SITEMAP_SRC" "$BLOG_SITEMAP_DST" \
            --content-type "application/json" \
            --cache-control "no-cache" \
            --quiet
        echo "  Published. Trigger api SitemapScheduler regenerate to refresh sitemap-blog.xml."
    else
        echo "[frontend] WARN: $BLOG_SITEMAP_SRC not found — skipping blog-sitemap publish (KS-4404)."
        echo "  (vite-blog-plugin может не отработать, если в apps/web/src/content/blog/ нет статей.)"
    fi
    _perf_stamp "frontend_blog_sitemap_publish_done"

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

    # KS-3709: предварительное скачивание board-recognition моделей в build-context.
    # Раньше Dockerfile выполнял `RUN node download-model.mjs ...` внутри docker build,
    # но RUN-шаг изолирован от учётных данных AWS хоста (`~/.aws/credentials` не
    # пробрасывается в build-контейнер), и все три скачивания падали с
    # CredentialsProviderError, `exit 0` глотал ошибку, манифест оставался пустым —
    # запекание не работало (см. KS-3709 замер от 2026-06-08 для коммита 83755265).
    #
    # Решение: качаем модели на хосте через `aws s3 cp` (учётные данные kingside-ci
    # уже есть на builder-хосте) и кладём в `apps/api/.bake-cache/`. Dockerfile
    # (production-стадия) делает `COPY apps/api/.bake-cache/ /var/cache/board-recog/`
    # вместо `RUN bake ...` — никаких сетевых вызовов внутри сборки.
    #
    # Версии (BAKE_RECOG_VERSION / BAKE_FINDBOARDS_VERSION) ОБЯЗАНЫ совпадать с
    # BOARD_RECOG_MODEL_VERSION / BOARD_FINDBOARDS_MODEL_VERSION в task-def kingside-api
    # production (см. API_EXTRA_ENV ниже и task-def env). Иначе entrypoint увидит
    # mismatch baked vs env и в рантайме всё равно пойдёт качать из S3. Версии
    # меняются раз в недели-месяцы; при смене — обновить в трёх местах: тут,
    # в production env task-def, в default-ARG `apps/api/Dockerfile`.
    BAKE_RECOG_VERSION="2.7.0"
    BAKE_FINDBOARDS_VERSION="1.1.0"
    BAKE_BUCKET="kingside-ml"
    BAKE_REGION="eu-central-1"
    BAKE_CACHE_DIR="$REPO_DIR/apps/api/.bake-cache"
    echo "[api] Pre-baking board-recognition models into $BAKE_CACHE_DIR ..."
    rm -rf "$BAKE_CACHE_DIR"
    mkdir -p "$BAKE_CACHE_DIR"
    BAKE_RECOG_OK=0
    BAKE_FIND_OK=0
    # board-recog классификатор (обязательный)
    if aws s3 cp --no-progress --region "$BAKE_REGION" \
            "s3://${BAKE_BUCKET}/models/board-recog/v${BAKE_RECOG_VERSION}/model.onnx" \
            "$BAKE_CACHE_DIR/model.onnx" 2>&1; then
        echo "  baked board-recog: model.onnx ($(stat -c %s "$BAKE_CACHE_DIR/model.onnx") bytes)"
        BAKE_RECOG_OK=1
    else
        echo "  WARN: failed to pre-bake board-recog v$BAKE_RECOG_VERSION — entrypoint fallback to runtime S3 download"
        rm -f "$BAKE_CACHE_DIR/model.onnx"
    fi
    # corner-detector (опциональный — для старых версий может отсутствовать в S3)
    if aws s3 cp --no-progress --region "$BAKE_REGION" \
            "s3://${BAKE_BUCKET}/models/board-recog/v${BAKE_RECOG_VERSION}/corner_detector.onnx" \
            "$BAKE_CACHE_DIR/corner_detector.onnx" 2>&1; then
        echo "  baked corner-detector: corner_detector.onnx ($(stat -c %s "$BAKE_CACHE_DIR/corner_detector.onnx") bytes)"
    else
        echo "  INFO: corner_detector v$BAKE_RECOG_VERSION not in S3 — opencv fallback in runtime"
        rm -f "$BAKE_CACHE_DIR/corner_detector.onnx"
    fi
    # find-boards (обязательный для двухстадийного пайплайна)
    if aws s3 cp --no-progress --region "$BAKE_REGION" \
            "s3://${BAKE_BUCKET}/models/board-recog/findboards_v${BAKE_FINDBOARDS_VERSION}/model.onnx" \
            "$BAKE_CACHE_DIR/findboards.onnx" 2>&1; then
        echo "  baked find-boards: findboards.onnx ($(stat -c %s "$BAKE_CACHE_DIR/findboards.onnx") bytes)"
        BAKE_FIND_OK=1
    else
        echo "  WARN: failed to pre-bake find-boards v$BAKE_FINDBOARDS_VERSION — entrypoint fallback to runtime S3 download"
        rm -f "$BAKE_CACHE_DIR/findboards.onnx"
    fi
    # Манифест запечённых версий — entrypoint сверяет с env-versions и пропускает
    # S3-загрузку, если совпало.
    {
        [ "$BAKE_RECOG_OK" = "1" ] && echo "BOARD_RECOG_MODEL_VERSION=${BAKE_RECOG_VERSION}"
        [ "$BAKE_FIND_OK"  = "1" ] && echo "BOARD_FINDBOARDS_MODEL_VERSION=${BAKE_FINDBOARDS_VERSION}"
    } > "$BAKE_CACHE_DIR/baked-versions"
    echo "  baked-versions manifest:"
    sed 's/^/    /' "$BAKE_CACHE_DIR/baked-versions"
    _perf_stamp "api_bake_models_done"

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
    # KS-3719: _with_ts добавляет `[NNN.NNN] ` перед каждой строкой → парсер
    # _parse_build_steps в _perf_summary восстанавливает длительность каждого
    # Step N/M. Grep / tail ниже всё ещё работают (текст строк сохранён).
    docker build --progress=plain -t "kingside-api:${DEPLOY_SHA}" \
        -f "$REPO_DIR/apps/api/Dockerfile" "$REPO_DIR" 2>&1 | _with_ts | tee "$BUILD_LOG"
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
    # KS-3719: пишем полный push-лог с таймштампами в PUSH_LOG → парсер
    # _parse_push_layers покажет длительность каждого слоя. В stdout
    # оставляем `tail -3` (digest + size) как раньше.
    PUSH_LOG="$REPO_DIR/logs/api-push-${DEPLOY_SHA}.log"
    set +e
    docker push "$NEW_IMAGE" 2>&1 | _with_ts | tee "$PUSH_LOG" | tail -3
    PUSH_RC=${PIPESTATUS[0]}
    set -e
    if [ "$PUSH_RC" -ne 0 ]; then
        echo "  ERROR: docker push failed (rc=$PUSH_RC). Full log: $PUSH_LOG"
        exit "$PUSH_RC"
    fi
    _perf_stamp "api_docker_push_done"

    # KS-3924: отдельный лёгкий migration-образ (node:20-slim + prisma CLI +
    # packages/db/prisma). Используется в pre-rollout `prisma migrate deploy`
    # вместо production-образа. Освобождает production от prisma CLI и
    # @prisma/engines (~170 МБ в распакованном виде, см. KS-3718).
    NEW_MIG_IMAGE="${ECR_URI_API_MIGRATIONS}:${DEPLOY_SHA}"
    ensure_ecr_repo "$ECR_REPO_API_MIGRATIONS"

    echo "[api] Building migrations image (tag=$DEPLOY_SHA)..."
    MIG_BUILD_LOG="$REPO_DIR/logs/api-migrations-build-${DEPLOY_SHA}.log"
    set +e
    docker build --progress=plain -t "kingside-api-migrations:${DEPLOY_SHA}" \
        -f "$REPO_DIR/scripts/Dockerfile.migrations" "$REPO_DIR" 2>&1 \
        | _with_ts | tee "$MIG_BUILD_LOG"
    MIG_BUILD_RC=${PIPESTATUS[0]}
    set -e
    if [ "$MIG_BUILD_RC" -ne 0 ]; then
        echo "  ERROR: migrations image build failed (rc=$MIG_BUILD_RC). Full log: $MIG_BUILD_LOG"
        tail -80 "$MIG_BUILD_LOG" || true
        exit "$MIG_BUILD_RC"
    fi
    _perf_stamp "api_migrations_build_done"

    echo "[api] Pushing ${ECR_REPO_API_MIGRATIONS}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-api-migrations:${DEPLOY_SHA}" "$NEW_MIG_IMAGE"
    MIG_PUSH_LOG="$REPO_DIR/logs/api-migrations-push-${DEPLOY_SHA}.log"
    set +e
    docker push "$NEW_MIG_IMAGE" 2>&1 | _with_ts | tee "$MIG_PUSH_LOG" | tail -3
    MIG_PUSH_RC=${PIPESTATUS[0]}
    set -e
    if [ "$MIG_PUSH_RC" -ne 0 ]; then
        echo "  ERROR: migrations push failed (rc=$MIG_PUSH_RC). Full log: $MIG_PUSH_LOG"
        exit "$MIG_PUSH_RC"
    fi
    _perf_stamp "api_migrations_push_done"

    echo "[api] Registering new task-def revision with image=:${DEPLOY_SHA}..."
    # KS-2108/KS-2109: admin endpoints (feature flags) требуют список логинов
    # в KS_ADMIN_USERS, default-deny если не задано. Прокидываем через
    # env-overrides, существующая env остаётся как есть.
    # 30.04 откат synthetic-stack (KS-2159..2179): SYNTHETIC_AVATARS_*
    # удалены из API_EXTRA_ENV, чтобы deploy api не возрождал фичу.
    # Bucket/IAM/БД-миграция оставлены до решения о новой архитектуре.
    # KS-3675 (ADR-107 rev 2 §6 D1): REVIEW_COMMENT_V2=on — расширенная
    # подсказка с позиционными субтермами для ReviewCommentService.
    # KS-3868 (ADR-116 B'): LECTURE_AUDIO_* — конфиг lecture-audio модуля
    # (требуется LectureAudioS3Service.onModuleInit в проде). Все 4
    # значения нечувствительны: имя бакета, публичный домен CDN, public
    # key-pair-id CloudFront и ИМЯ секрета в Secrets Manager (сам ключ
    # читается через secretsmanager:GetSecretValue из ecsTaskRole inline
    # policy kingside-lectures-s3-access, см. KS-3821/KS-3828).
    API_EXTRA_ENV='[{"name":"KS_ADMIN_USERS","value":"Stanislav"},{"name":"REVIEW_COMMENT_V2","value":"on"},{"name":"LECTURE_AUDIO_BUCKET","value":"kingside-lectures"},{"name":"LECTURE_AUDIO_CDN_BASE","value":"https://media.kingside.site"},{"name":"LECTURE_AUDIO_CDN_KEY_PAIR_ID","value":"K22OGMBTKZ8IZR"},{"name":"LECTURE_AUDIO_CDN_PRIVATE_KEY_SECRET_NAME","value":"kingside/cloudfront/lectures-signing-key"}]'
    NEW_TD_ARN=$(register_new_task_def_with_image "$TD_FAMILY_API" "$NEW_IMAGE" "$API_EXTRA_ENV")
    echo "  task-def: $NEW_TD_ARN"
    _perf_stamp "api_taskdef_done"

    # KS-3491: миграции api живут в packages/db/prisma/migrations (см. KS-1550,
    # 16-04-2026). Старый путь `apps/api/prisma/migrations` не существует —
    # это и приводило к тихому пропуску миграций до KS-3491.
    if should_run_migrate "api" "packages/db/prisma/migrations"; then
        echo "[api] Running Prisma migrations on dedicated migration image..."
        ensure_migrate_network
        # KS-3924: migrate бежит не на production-образе, а на отдельном
        # kingside-api-migrations. На каждый деплой регистрируем новую revision
        # `kingside-api-migrate`, клонируя текущую активную production-revision
        # `kingside-api` (env/secrets/DATABASE_URL/IAM-роли всегда в синхроне).
        # Команду не override-им — ENTRYPOINT migration-образа уже
        # `npx prisma migrate deploy`. WORKDIR /app, schema лежит в
        # /app/prisma/schema.prisma (см. scripts/Dockerfile.migrations).
        NEW_MIG_TD_ARN=$(register_migrate_task_def_revision \
            "$TD_FAMILY_API_MIGRATE" "$TD_FAMILY_API" "$NEW_MIG_IMAGE")
        echo "  migrate task-def: $NEW_MIG_TD_ARN"
        MIGRATE_TASK=$(aws ecs run-task \
            --cluster "$ECS_CLUSTER" --task-definition "$NEW_MIG_TD_ARN" --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[$MIGRATE_SUBNET],securityGroups=[$MIGRATE_SG],assignPublicIp=ENABLED}" \
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
    # KS-3719: --progress=plain + _with_ts + tee → парсер шагов в _perf_summary.
    BUILD_LOG="$REPO_DIR/logs/game-service-build-${DEPLOY_SHA}.log"
    mkdir -p "$REPO_DIR/logs"
    set +e
    docker build --progress=plain -t "kingside-game-service:${DEPLOY_SHA}" \
        -f "$REPO_DIR/apps/game-service/Dockerfile" "$REPO_DIR" 2>&1 | _with_ts | tee "$BUILD_LOG"
    BUILD_RC=${PIPESTATUS[0]}
    set -e
    if [ "$BUILD_RC" -ne 0 ]; then
        echo "  ERROR: docker build failed (rc=$BUILD_RC). Full log: $BUILD_LOG"
        tail -80 "$BUILD_LOG" || true
        exit "$BUILD_RC"
    fi
    _perf_stamp "game_docker_build_done"

    echo "[game-service] Pushing ${ECR_REPO_GAME}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-game-service:${DEPLOY_SHA}" "$NEW_IMAGE"
    # KS-3719: push log с таймштампами → парсер слоёв в _perf_summary.
    PUSH_LOG="$REPO_DIR/logs/game-service-push-${DEPLOY_SHA}.log"
    set +e
    docker push "$NEW_IMAGE" 2>&1 | _with_ts | tee "$PUSH_LOG" | tail -3
    PUSH_RC=${PIPESTATUS[0]}
    set -e
    if [ "$PUSH_RC" -ne 0 ]; then
        echo "  ERROR: docker push failed (rc=$PUSH_RC). Full log: $PUSH_LOG"
        exit "$PUSH_RC"
    fi
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
    # KS-3719: --progress=plain + _with_ts + tee → парсер шагов в _perf_summary.
    BUILD_LOG="$REPO_DIR/logs/broadcast-service-build-${DEPLOY_SHA}.log"
    mkdir -p "$REPO_DIR/logs"
    set +e
    docker build --progress=plain -t "kingside-broadcast-service:${DEPLOY_SHA}" \
        -f "$REPO_DIR/apps/broadcast-service/Dockerfile" "$REPO_DIR" 2>&1 | _with_ts | tee "$BUILD_LOG"
    BUILD_RC=${PIPESTATUS[0]}
    set -e
    if [ "$BUILD_RC" -ne 0 ]; then
        echo "  ERROR: docker build failed (rc=$BUILD_RC). Full log: $BUILD_LOG"
        tail -80 "$BUILD_LOG" || true
        exit "$BUILD_RC"
    fi
    _perf_stamp "broadcast_docker_build_done"

    echo "[broadcast-service] Pushing ${ECR_REPO_BROADCAST_SERVICE}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-broadcast-service:${DEPLOY_SHA}" "$NEW_IMAGE"
    # KS-3719: push log с таймштампами → парсер слоёв в _perf_summary.
    PUSH_LOG="$REPO_DIR/logs/broadcast-service-push-${DEPLOY_SHA}.log"
    set +e
    docker push "$NEW_IMAGE" 2>&1 | _with_ts | tee "$PUSH_LOG" | tail -3
    PUSH_RC=${PIPESTATUS[0]}
    set -e
    if [ "$PUSH_RC" -ne 0 ]; then
        echo "  ERROR: docker push failed (rc=$PUSH_RC). Full log: $PUSH_LOG"
        exit "$PUSH_RC"
    fi
    _perf_stamp "broadcast_docker_push_done"

    # KS-3925: отдельный лёгкий migration-образ (node:20-slim + prisma CLI +
    # packages/broadcasts-db/prisma). Используется в pre-rollout `prisma migrate
    # deploy` вместо production-образа. Освобождает production от prisma CLI и
    # @prisma/engines (~30-60 МБ сжатых).
    NEW_MIG_IMAGE="${ECR_URI_BROADCAST_MIGRATIONS}:${DEPLOY_SHA}"
    ensure_ecr_repo "$ECR_REPO_BROADCAST_MIGRATIONS"

    echo "[broadcast-service] Building migrations image (tag=$DEPLOY_SHA)..."
    MIG_BUILD_LOG="$REPO_DIR/logs/broadcast-service-migrations-build-${DEPLOY_SHA}.log"
    set +e
    docker build --progress=plain -t "kingside-broadcast-service-migrations:${DEPLOY_SHA}" \
        -f "$REPO_DIR/scripts/Dockerfile.broadcast-migrations" "$REPO_DIR" 2>&1 \
        | _with_ts | tee "$MIG_BUILD_LOG"
    MIG_BUILD_RC=${PIPESTATUS[0]}
    set -e
    if [ "$MIG_BUILD_RC" -ne 0 ]; then
        echo "  ERROR: migrations image build failed (rc=$MIG_BUILD_RC). Full log: $MIG_BUILD_LOG"
        tail -80 "$MIG_BUILD_LOG" || true
        exit "$MIG_BUILD_RC"
    fi
    _perf_stamp "broadcast_migrations_build_done"

    echo "[broadcast-service] Pushing ${ECR_REPO_BROADCAST_MIGRATIONS}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-broadcast-service-migrations:${DEPLOY_SHA}" "$NEW_MIG_IMAGE"
    MIG_PUSH_LOG="$REPO_DIR/logs/broadcast-service-migrations-push-${DEPLOY_SHA}.log"
    set +e
    docker push "$NEW_MIG_IMAGE" 2>&1 | _with_ts | tee "$MIG_PUSH_LOG" | tail -3
    MIG_PUSH_RC=${PIPESTATUS[0]}
    set -e
    if [ "$MIG_PUSH_RC" -ne 0 ]; then
        echo "  ERROR: migrations push failed (rc=$MIG_PUSH_RC). Full log: $MIG_PUSH_LOG"
        exit "$MIG_PUSH_RC"
    fi
    _perf_stamp "broadcast_migrations_push_done"

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
        # KS-3474: skip-логика выпилена, всегда run.
        # KS-3925: migrate бежит не на production-образе, а на отдельном
        # kingside-broadcast-service-migrations. На каждый деплой регистрируем
        # новую revision `kingside-broadcast-service-migrate`, клонируя текущую
        # активную production-revision `kingside-broadcast-service` (env/secrets/
        # BROADCASTS_DATABASE_URL/IAM-роли всегда в синхроне). Команду не override-им —
        # ENTRYPOINT migration-образа уже `npx prisma migrate deploy`. WORKDIR /app,
        # schema лежит в /app/prisma/schema.prisma (см. scripts/Dockerfile.broadcast-migrations).
        if should_run_migrate "broadcast" "packages/broadcasts-db/prisma/migrations"; then
            echo "[broadcast-service] Running Prisma migrations (broadcasts-db) on dedicated migration image..."
            ensure_migrate_network
            NEW_MIG_TD_ARN=$(register_migrate_task_def_revision \
                "$TD_FAMILY_BROADCAST_MIGRATE" "$TD_FAMILY_BROADCAST_SERVICE" "$NEW_MIG_IMAGE")
            echo "  migrate task-def: $NEW_MIG_TD_ARN"
            MIGRATE_TASK=$(aws ecs run-task \
                --cluster "$ECS_CLUSTER" --task-definition "$NEW_MIG_TD_ARN" --launch-type FARGATE \
                --network-configuration "awsvpcConfiguration={subnets=[$MIGRATE_SUBNET],securityGroups=[$MIGRATE_SG],assignPublicIp=ENABLED}" \
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
    # KS-3719: --progress=plain + _with_ts + tee → парсер шагов в _perf_summary.
    BUILD_LOG="$REPO_DIR/logs/archive-service-build-${DEPLOY_SHA}.log"
    mkdir -p "$REPO_DIR/logs"
    set +e
    docker build --progress=plain -t "kingside-archive-service:${DEPLOY_SHA}" \
        -f "$REPO_DIR/apps/archive-service/Dockerfile" "$REPO_DIR" 2>&1 | _with_ts | tee "$BUILD_LOG"
    BUILD_RC=${PIPESTATUS[0]}
    set -e
    if [ "$BUILD_RC" -ne 0 ]; then
        echo "  ERROR: docker build failed (rc=$BUILD_RC). Full log: $BUILD_LOG"
        tail -80 "$BUILD_LOG" || true
        exit "$BUILD_RC"
    fi
    _perf_stamp "archive_docker_build_done"

    echo "[archive-service] Pushing ${ECR_REPO_ARCHIVE_SERVICE}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-archive-service:${DEPLOY_SHA}" "$NEW_IMAGE"
    # KS-3719: push log с таймштампами → парсер слоёв в _perf_summary.
    PUSH_LOG="$REPO_DIR/logs/archive-service-push-${DEPLOY_SHA}.log"
    set +e
    docker push "$NEW_IMAGE" 2>&1 | _with_ts | tee "$PUSH_LOG" | tail -3
    PUSH_RC=${PIPESTATUS[0]}
    set -e
    if [ "$PUSH_RC" -ne 0 ]; then
        echo "  ERROR: docker push failed (rc=$PUSH_RC). Full log: $PUSH_LOG"
        exit "$PUSH_RC"
    fi
    _perf_stamp "archive_docker_push_done"

    # KS-3925: отдельный лёгкий migration-образ (node:20-slim + prisma CLI +
    # packages/archive-db/prisma). Используется в pre-rollout `prisma migrate
    # deploy` вместо production-образа. Освобождает production от prisma CLI и
    # @prisma/engines (~30-60 МБ сжатых). Одна migrate-family на все три
    # ARCHIVE_TD_FAMILIES — БД одна (archive_kingside).
    NEW_MIG_IMAGE="${ECR_URI_ARCHIVE_MIGRATIONS}:${DEPLOY_SHA}"
    ensure_ecr_repo "$ECR_REPO_ARCHIVE_MIGRATIONS"

    echo "[archive-service] Building migrations image (tag=$DEPLOY_SHA)..."
    MIG_BUILD_LOG="$REPO_DIR/logs/archive-service-migrations-build-${DEPLOY_SHA}.log"
    set +e
    docker build --progress=plain -t "kingside-archive-service-migrations:${DEPLOY_SHA}" \
        -f "$REPO_DIR/scripts/Dockerfile.archive-migrations" "$REPO_DIR" 2>&1 \
        | _with_ts | tee "$MIG_BUILD_LOG"
    MIG_BUILD_RC=${PIPESTATUS[0]}
    set -e
    if [ "$MIG_BUILD_RC" -ne 0 ]; then
        echo "  ERROR: migrations image build failed (rc=$MIG_BUILD_RC). Full log: $MIG_BUILD_LOG"
        tail -80 "$MIG_BUILD_LOG" || true
        exit "$MIG_BUILD_RC"
    fi
    _perf_stamp "archive_migrations_build_done"

    echo "[archive-service] Pushing ${ECR_REPO_ARCHIVE_MIGRATIONS}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-archive-service-migrations:${DEPLOY_SHA}" "$NEW_MIG_IMAGE"
    MIG_PUSH_LOG="$REPO_DIR/logs/archive-service-migrations-push-${DEPLOY_SHA}.log"
    set +e
    docker push "$NEW_MIG_IMAGE" 2>&1 | _with_ts | tee "$MIG_PUSH_LOG" | tail -3
    MIG_PUSH_RC=${PIPESTATUS[0]}
    set -e
    if [ "$MIG_PUSH_RC" -ne 0 ]; then
        echo "  ERROR: migrations push failed (rc=$MIG_PUSH_RC). Full log: $MIG_PUSH_LOG"
        exit "$MIG_PUSH_RC"
    fi
    _perf_stamp "archive_migrations_push_done"

    ARCHIVE_SVC_STATUS=$(aws ecs describe-services \
        --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_ARCHIVE_SERVICE" \
        --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")
    # KS-4313: HTTP-эндпоинты archive-service вынесены в основной API (ADR-131,
    # KS-4247). daemon kingside-archive-service ещё ACTIVE (formally), но
    # desiredCount=0 и target-group `kingside-archive-api` отвязана от ALB —
    # любой UpdateService падает InvalidParameterException. Деплой
    # archive-service после ADR-131 нужен ТОЛЬКО ради importer-oneshot
    # (EventBridge Scheduler + adhoc RunTask). Гейтим update-service / smoke
    # /tree / services-stable по desiredCount>0 — если daemon когда-нибудь
    # вернут (поднимут desired), ветка снова заработает.
    ARCHIVE_SVC_DESIRED=$(aws ecs describe-services \
        --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_ARCHIVE_SERVICE" \
        --query 'services[0].desiredCount' --output text 2>/dev/null || echo "0")
    [ "$ARCHIVE_SVC_DESIRED" = "None" ] && ARCHIVE_SVC_DESIRED=0
    ARCHIVE_HTTP_RUNNABLE=false
    if [ "$ARCHIVE_SVC_STATUS" = "ACTIVE" ] && [ "$ARCHIVE_SVC_DESIRED" -gt 0 ] 2>/dev/null; then
        ARCHIVE_HTTP_RUNNABLE=true
    fi
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
        # KS-3474: skip-логика выпилена, всегда run.
        # KS-3925: migrate бежит не на production-образе, а на отдельном
        # kingside-archive-service-migrations. На каждый деплой регистрируем
        # новую revision `kingside-archive-service-migrate`, клонируя текущую
        # активную production-revision `kingside-archive-service` (env/secrets/
        # ARCHIVE_DATABASE_URL/IAM-роли всегда в синхроне). Команду не override-им —
        # ENTRYPOINT migration-образа уже `npx prisma migrate deploy`. WORKDIR /app,
        # schema лежит в /app/prisma/schema.prisma (см. scripts/Dockerfile.archive-migrations).
        if should_run_migrate "archive" "packages/archive-db/prisma/migrations"; then
            echo "[archive-service] Running Prisma migrations (archive-db) on dedicated migration image..."
            ensure_migrate_network
            NEW_MIG_TD_ARN=$(register_migrate_task_def_revision \
                "$TD_FAMILY_ARCHIVE_MIGRATE" "$TD_FAMILY_ARCHIVE_SERVICE" "$NEW_MIG_IMAGE")
            echo "  migrate task-def: $NEW_MIG_TD_ARN"
            MIGRATE_TASK=$(aws ecs run-task \
                --cluster "$ECS_CLUSTER" --task-definition "$NEW_MIG_TD_ARN" --launch-type FARGATE \
                --network-configuration "awsvpcConfiguration={subnets=[$MIGRATE_SUBNET],securityGroups=[$MIGRATE_SG],assignPublicIp=ENABLED}" \
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

    # Rolling update ECS-сервисов. После ADR-131 (KS-4247) HTTP-эндпоинты
    # archive-service переехали в основной API; daemon kingside-archive-service
    # ACTIVE-но-desiredCount=0 и target-group без ALB — UpdateService на нём
    # гарантированно падает InvalidParameterException. Поэтому гейт по
    # ARCHIVE_HTTP_RUNNABLE (status=ACTIVE && desiredCount>0). Когда daemon
    # снова поднимут — ветка автоматически включится.
    # importer-сервис MISSING после ADR-020 (заменён EventBridge Scheduler).
    if $ARCHIVE_HTTP_RUNNABLE; then
        echo "[archive-service] Updating ECS service $ECS_SERVICE_ARCHIVE_SERVICE to new revision..."
        aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_ARCHIVE_SERVICE" \
            --task-definition "$NEW_TD_HTTP_ARN" \
            --force-new-deployment --query 'service.deployments[0].status' --output text
        echo "  ECS service $ECS_SERVICE_ARCHIVE_SERVICE update initiated."
    else
        echo "[archive-service] HTTP daemon dormant (status=$ARCHIVE_SVC_STATUS desired=$ARCHIVE_SVC_DESIRED) — skipping update-service (ADR-131: HTTP migrated to apps/api)."
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
    # KS-4313: smoke выполняем только если HTTP daemon реально работает.
    # После ADR-131 `archive.kingside.site/tree` — это уже основной API
    # (kingside-api-tg target group), smoke-gate тут не релевантен для
    # importer-oneshot деплоя. Если daemon вернут — гейт снова включится.
    if $ARCHIVE_HTTP_RUNNABLE; then
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
    # KS-4313: после ADR-131 smoke /tree для importer-oneshot деплоя
    # пропускается (HTTP daemon dormant) — scheduler обновляется без HTTP-гейта.
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
    # KS-3633: tee полного docker-build лога в /project/logs, симметрично
    # api-блоку (см. KS-2441). Без этого MCP-тул deploy обрезает stdout, и при
    # падении на этапе COPY/npm install (например, workspace-deps не скопирован
    # в образ) полная причина не видна — приходится гадать. С `--progress=plain`
    # каждый шаг идёт построчно с префиксом #N <step>, tee гарантирует полный
    # лог в файле. /project/logs/ шарится между webhook-сервером и агентским
    # контейнером — devops читает лог сразу после деплоя.
    BUILD_LOG="$REPO_DIR/logs/tactic-worker-build-${DEPLOY_SHA}.log"
    mkdir -p "$REPO_DIR/logs"
    set +e
    # KS-3719: _with_ts добавляет таймштампы → парсер шагов в _perf_summary.
    # Имя файла унифицировано на tactic-worker-build-* (раньше было tactic-build-*)
    # чтобы парсер вытаскивал название сервиса из basename единообразно.
    docker build --progress=plain -t "kingside-tactic-worker:${DEPLOY_SHA}" \
        -f "$REPO_DIR/apps/tactic-worker/Dockerfile" "$REPO_DIR" 2>&1 | _with_ts | tee "$BUILD_LOG"
    BUILD_RC=${PIPESTATUS[0]}
    set -e
    if [ "$BUILD_RC" -ne 0 ]; then
        echo ""
        echo "  ERROR: docker build failed (rc=$BUILD_RC). Full log: $BUILD_LOG"
        echo "  --- npm / docker error context ---"
        grep -E 'npm (error|warn) (code|Missing|Invalid|EUSAGE|peer|require|Tracker)|npm ci|COPY failed|ERROR \[|failed to compute cache key|no such file|not found' "$BUILD_LOG" \
            | head -120 || true
        echo "  --- last 80 lines of build log ---"
        tail -80 "$BUILD_LOG" || true
        exit "$BUILD_RC"
    fi
    _perf_stamp "tactic_docker_build_done"

    echo "[tactic-worker] Pushing ${ECR_REPO_TACTIC_WORKER}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-tactic-worker:${DEPLOY_SHA}" "$NEW_IMAGE"
    # KS-3719: push log с таймштампами → парсер слоёв в _perf_summary.
    PUSH_LOG="$REPO_DIR/logs/tactic-worker-push-${DEPLOY_SHA}.log"
    set +e
    docker push "$NEW_IMAGE" 2>&1 | _with_ts | tee "$PUSH_LOG" | tail -3
    PUSH_RC=${PIPESTATUS[0]}
    set -e
    if [ "$PUSH_RC" -ne 0 ]; then
        echo "  ERROR: docker push failed (rc=$PUSH_RC). Full log: $PUSH_LOG"
        exit "$PUSH_RC"
    fi
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
# --- Prerender Service (apps/prerender-service): docker build → ECR push под :<sha> →
#     register-task-def revision → update-service → services-stable → atomic :latest ---
# KS-4194 / ADR-128 §7.3. SQS-воркер на Playwright: тянет PrerenderTask из
# kingside-prerender-tasks, рендерит kingside.site/<path>, кладёт HTML в
# kingside-prerender-store. Миграций нет (БД нет). На старте 1 task 24/7.
#
# Bootstrap-семантика: если ECS service ещё не существует (первичный pre-rollout
# до создания сервиса), build+push+register-task-def выполняем, но update-service /
# services-stable / atomic :latest пропускаем — после первого пуша создаём сервис
# вручную через aws ecs create-service (см. KS-4194 runbook), последующие деплои
# уже идут полным циклом.
if $DEPLOY_PRERENDER_SERVICE; then
    _perf_stamp "prerender_start"
    NEW_IMAGE="${ECR_URI_PRERENDER_SERVICE}:${DEPLOY_SHA}"

    echo "[prerender-service] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null
    _perf_stamp "prerender_ecr_login_done"

    ensure_ecr_repo "$ECR_REPO_PRERENDER_SERVICE"

    echo "[prerender-service] Building Docker image (tag=$DEPLOY_SHA)..."
    BUILD_LOG="$REPO_DIR/logs/prerender-service-build-${DEPLOY_SHA}.log"
    mkdir -p "$REPO_DIR/logs"
    set +e
    docker build --progress=plain -t "kingside-prerender-service:${DEPLOY_SHA}" \
        -f "$REPO_DIR/apps/prerender-service/Dockerfile" "$REPO_DIR" 2>&1 | _with_ts | tee "$BUILD_LOG"
    BUILD_RC=${PIPESTATUS[0]}
    set -e
    if [ "$BUILD_RC" -ne 0 ]; then
        echo "  ERROR: docker build failed (rc=$BUILD_RC). Full log: $BUILD_LOG"
        tail -80 "$BUILD_LOG" || true
        exit "$BUILD_RC"
    fi
    _perf_stamp "prerender_docker_build_done"

    echo "[prerender-service] Pushing ${ECR_REPO_PRERENDER_SERVICE}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-prerender-service:${DEPLOY_SHA}" "$NEW_IMAGE"
    PUSH_LOG="$REPO_DIR/logs/prerender-service-push-${DEPLOY_SHA}.log"
    set +e
    docker push "$NEW_IMAGE" 2>&1 | _with_ts | tee "$PUSH_LOG" | tail -3
    PUSH_RC=${PIPESTATUS[0]}
    set -e
    if [ "$PUSH_RC" -ne 0 ]; then
        echo "  ERROR: docker push failed (rc=$PUSH_RC). Full log: $PUSH_LOG"
        exit "$PUSH_RC"
    fi
    _perf_stamp "prerender_docker_push_done"

    # Проверяем существование task-def family: при первом деплое его ещё нет —
    # регистрируем напрямую из apps/prerender-service/task-definition.json, потом
    # переписываем image на :<sha>. Последующие деплои — клонируем последнюю
    # активную revision через register_new_task_def_with_image.
    TD_LATEST_ARN=$(aws ecs describe-task-definition --task-definition "$TD_FAMILY_PRERENDER_SERVICE" \
        --query 'taskDefinition.taskDefinitionArn' --output text 2>/dev/null || echo "NONE")
    if [ "$TD_LATEST_ARN" = "NONE" ]; then
        echo "[prerender-service] task-def family '$TD_FAMILY_PRERENDER_SERVICE' missing — bootstrap from apps/prerender-service/task-definition.json"
        ensure_jq
        BOOTSTRAP_TD_JSON=$(jq --arg img "$NEW_IMAGE" \
            '.containerDefinitions[0].image=$img' \
            "$REPO_DIR/apps/prerender-service/task-definition.json")
        NEW_TD_ARN=$(aws ecs register-task-definition --cli-input-json "$BOOTSTRAP_TD_JSON" \
            --query 'taskDefinition.taskDefinitionArn' --output text)
    else
        echo "[prerender-service] Registering new task-def revision with image=:${DEPLOY_SHA}..."
        NEW_TD_ARN=$(register_new_task_def_with_image "$TD_FAMILY_PRERENDER_SERVICE" "$NEW_IMAGE")
    fi
    echo "  task-def: $NEW_TD_ARN"
    _perf_stamp "prerender_taskdef_done"

    SVC_STATUS=$(aws ecs describe-services \
        --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_PRERENDER_SERVICE" \
        --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")
    _perf_stamp "prerender_describe_service_done"

    if [ "$SVC_STATUS" = "ACTIVE" ]; then
        echo "[prerender-service] Updating ECS service to new revision..."
        aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_PRERENDER_SERVICE" \
            --task-definition "$NEW_TD_ARN" \
            --force-new-deployment --query 'service.deployments[0].status' --output text
        echo "  ECS service update initiated."
        _perf_stamp "prerender_update_service_done"

        echo "[prerender-service] Waiting for rollout to stabilize..."
        if ! aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_PRERENDER_SERVICE"; then
            echo "  ERROR: services-stable timed out or failed. :latest NOT moved."
            echo "  Rollback: см. runbook в шапке deploy-aws.sh."
            exit 1
        fi
        echo "  Rollout stable."
        _perf_stamp "prerender_services_stable_done"

        echo "[prerender-service] Atomic move ${ECR_REPO_PRERENDER_SERVICE}:latest → :${DEPLOY_SHA}..."
        ecr_move_latest_to_tag "$ECR_REPO_PRERENDER_SERVICE" "$DEPLOY_SHA"
        _perf_stamp "prerender_atomic_latest_done"
    else
        echo "[prerender-service] ECS service '$ECS_SERVICE_PRERENDER_SERVICE' not found (status=$SVC_STATUS)."
        echo "[prerender-service] Bootstrap flow: после первого push образа devops создаёт сервис вручную (aws ecs create-service)."
        echo "[prerender-service] :latest НЕ перенесён (bootstrap)."
        # Один раз вручную проставляем :latest на свежий :<sha>, чтобы create-service
        # на :latest подхватил рабочий образ. На последующих деплоях это делает
        # atomic move выше — после успешного services-stable.
        echo "[prerender-service] Bootstrap: вручную проставляем ${ECR_REPO_PRERENDER_SERVICE}:latest на :${DEPLOY_SHA} (одноразовая операция первичного запуска)."
        ecr_move_latest_to_tag "$ECR_REPO_PRERENDER_SERVICE" "$DEPLOY_SHA" || true
    fi
fi

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
