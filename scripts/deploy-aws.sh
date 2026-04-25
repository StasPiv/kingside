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
# Образ kingside-archive-service используется четырьмя task-def family:
#   - kingside-archive-service           — ECS service (HTTP, /tree)
#   - kingside-archive-importer          — наследие ADR-019 (нет потребителя)
#   - kingside-archive-importer-oneshot  — EventBridge daily (kingside-archive-importer-daily)
#   - kingside-archive-importer-adhoc    — adhoc batch / dev (manual aws ecs run-task)
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

# AWS config
REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID="342946498289"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-api"
ECR_URI_GAME="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-game-service"
ECR_URI_BROADCAST_SERVICE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-broadcast-service"
ECR_URI_ARCHIVE_SERVICE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-archive-service"
# Короткие имена ECR-repo для aws ecr put-image / batch-get-image.
ECR_REPO_API="kingside-api"
ECR_REPO_GAME="kingside-game-service"
ECR_REPO_BROADCAST_SERVICE="kingside-broadcast-service"
ECR_REPO_ARCHIVE_SERVICE="kingside-archive-service"
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
# KS-1897: все task-def family использующие образ kingside-archive-service.
# Регистрируются на pinned SHA при каждом scope=archive-service деплое
# (см. шапку файла, секцию KS-1897).
ARCHIVE_TD_FAMILIES=(
    "kingside-archive-service"            # ECS service (HTTP, /tree)
    "kingside-archive-importer"           # legacy ADR-019, нет потребителя (см. C-следствие KS-1897)
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
PROD_VITE_FEATURE_LESSONS="false"
DEPLOY_COMMIT_FILE="$REPO_DIR/.deploy-commit-aws"

# Load .env
if [ -f "$REPO_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$REPO_DIR/.env"
    set +a
fi

export AWS_DEFAULT_REGION="$REGION"

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
    ensure_jq
    local tmp
    tmp=$(mktemp)
    aws ecs describe-task-definition --task-definition "$family" \
        --query 'taskDefinition' --output json \
        | jq --arg img "$new_image" '
            .containerDefinitions |= map(.image = $img)
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
    # put-image перезаписывает существующий :latest (tag mutability=MUTABLE).
    # Если :latest уже указывает на тот же manifest — AWS вернёт
    # ImageAlreadyExistsException, тогда ничего не делаем.
    if aws ecr put-image \
        --repository-name "$repo" \
        --image-tag latest \
        --image-manifest "$manifest" \
        --output text >/dev/null 2>&1; then
        echo "  :latest → ${repo}:${src_tag} (atomic move)."
    else
        # Проверим, что причина — идентичность manifest, а не реальный сбой.
        local latest_digest
        latest_digest=$(aws ecr batch-get-image \
            --repository-name "$repo" \
            --image-ids imageTag=latest \
            --query 'images[0].imageId.imageDigest' --output text 2>/dev/null || echo "")
        local sha_digest
        sha_digest=$(aws ecr batch-get-image \
            --repository-name "$repo" \
            --image-ids imageTag="$src_tag" \
            --query 'images[0].imageId.imageDigest' --output text 2>/dev/null || echo "")
        if [ -n "$latest_digest" ] && [ "$latest_digest" = "$sha_digest" ]; then
            echo "  :latest already points to ${repo}:${src_tag} (no-op)."
        else
            echo "  ERROR: aws ecr put-image failed and :latest is NOT on ${src_tag} (digest mismatch)."
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
            packages/shared/*)
                has_frontend=true
                has_api=true
                has_game=true
                has_broadcast_service=true
                has_archive_service=true ;;
            scripts/*|infra/*|justfile)
                has_frontend=true
                has_api=true
                has_game=true
                has_broadcast_service=true
                has_archive_service=true ;;
        esac
    done <<< "$changed_files"

    # Multiple services changed → deploy all
    local count=0
    $has_frontend && count=$((count + 1))
    $has_api && count=$((count + 1))
    $has_game && count=$((count + 1))
    $has_broadcast_service && count=$((count + 1))
    $has_archive_service && count=$((count + 1))

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
    else
        echo "none"
    fi
}

# --- Main ---

FORCE_SCOPE="${1:-auto}"

fix_symlinks
ensure_deps

if [ "$FORCE_SCOPE" = "auto" ]; then
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

DEPLOY_FRONTEND=false
DEPLOY_API=false
DEPLOY_GAME=false
DEPLOY_BROADCAST_SERVICE=false
DEPLOY_ARCHIVE_SERVICE=false

case "$SCOPE" in
    frontend)           DEPLOY_FRONTEND=true ;;
    api)                DEPLOY_API=true ;;
    game-service)       DEPLOY_GAME=true ;;
    broadcast-service)  DEPLOY_BROADCAST_SERVICE=true ;;
    archive-service)    DEPLOY_ARCHIVE_SERVICE=true ;;
    workers)            DEPLOY_BROADCAST_SERVICE=true; DEPLOY_ARCHIVE_SERVICE=true ;;
    all)                DEPLOY_FRONTEND=true; DEPLOY_API=true; DEPLOY_GAME=true; DEPLOY_BROADCAST_SERVICE=true; DEPLOY_ARCHIVE_SERVICE=true ;;
    *)                  echo "Unknown scope: $SCOPE"; exit 1 ;;
esac

echo ""
echo "=== Deploy Kingside to AWS ($SCOPE) ==="
echo "=== Build tag (KS-1826): $DEPLOY_SHA"
echo ""

# --- Frontend: vite build → S3 sync → CloudFront invalidation ---
# Frontend не использует ECR — атомарность ECR-тегов не применима.
if $DEPLOY_FRONTEND; then
    echo "[frontend] Building (VITE_API_URL=$PROD_VITE_API_URL, VITE_ARCHIVE_URL=$PROD_VITE_ARCHIVE_URL, VITE_BROADCAST_URL=$PROD_VITE_BROADCAST_URL, VITE_APP_ORIGIN=$PROD_API_URL, VITE_GAME_URL=$PROD_GAME_URL, VITE_GA4_ID=$PROD_GA4_ID, VITE_FEATURE_LESSONS=$PROD_VITE_FEATURE_LESSONS)..."
    VITE_API_URL="$PROD_VITE_API_URL" VITE_ARCHIVE_URL="$PROD_VITE_ARCHIVE_URL" VITE_BROADCAST_URL="$PROD_VITE_BROADCAST_URL" VITE_APP_ORIGIN="$PROD_API_URL" VITE_GAME_URL="$PROD_GAME_URL" VITE_GA4_ID="$PROD_GA4_ID" VITE_FEATURE_LESSONS="$PROD_VITE_FEATURE_LESSONS" npm run build --prefix "$REPO_DIR" --workspace=apps/web
    echo "  Built: $REPO_DIR/apps/web/dist"

    echo "[frontend] Syncing to S3..."
    aws s3 sync "$REPO_DIR/apps/web/dist/" "s3://${S3_BUCKET}/" --delete --quiet
    echo "  Synced to s3://$S3_BUCKET/"

    echo "[frontend] Invalidating CloudFront cache..."
    aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION" \
        --paths "/*" --query 'Invalidation.Id' --output text
    echo "  CloudFront invalidation created."
fi

# --- API: docker build → ECR push под :<sha> → migrate → update-service →
#         services-stable → put-image :latest (атомарный move) ---
if $DEPLOY_API; then
    NEW_IMAGE="${ECR_URI}:${DEPLOY_SHA}"

    echo "[api] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null

    echo "[api] Building Docker image (tag=$DEPLOY_SHA)..."
    docker build -t "kingside-api:${DEPLOY_SHA}" -f "$REPO_DIR/apps/api/Dockerfile" "$REPO_DIR"

    echo "[api] Pushing ${ECR_REPO_API}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-api:${DEPLOY_SHA}" "$NEW_IMAGE"
    docker push "$NEW_IMAGE" 2>&1 | tail -3

    echo "[api] Registering new task-def revision with image=:${DEPLOY_SHA}..."
    NEW_TD_ARN=$(register_new_task_def_with_image "$TD_FAMILY_API" "$NEW_IMAGE")
    echo "  task-def: $NEW_TD_ARN"

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

    echo "[api] Updating ECS service to new revision..."
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
        --task-definition "$NEW_TD_ARN" \
        --force-new-deployment --query 'service.deployments[0].status' --output text
    echo "  ECS service update initiated."

    echo "[api] Waiting for rollout to stabilize..."
    if ! aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE"; then
        echo "  ERROR: services-stable timed out or failed. :latest NOT moved."
        echo "  Rollback: см. runbook в шапке deploy-aws.sh."
        exit 1
    fi
    echo "  Rollout stable."

    echo "[api] Atomic move ${ECR_REPO_API}:latest → :${DEPLOY_SHA}..."
    ecr_move_latest_to_tag "$ECR_REPO_API" "$DEPLOY_SHA"
fi

# --- Game Service: docker build → ECR push под :<sha> → update-service →
#                   services-stable → put-image :latest (атомарный move) ---
# Миграций нет (game-service stateless). Smoke пока тоже нет (см. KS-1817 — там
# появился только для broadcast/archive). Gate = services-stable.
if $DEPLOY_GAME; then
    NEW_IMAGE="${ECR_URI_GAME}:${DEPLOY_SHA}"

    echo "[game-service] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null

    echo "[game-service] Building Docker image (tag=$DEPLOY_SHA)..."
    docker build -t "kingside-game-service:${DEPLOY_SHA}" -f "$REPO_DIR/apps/game-service/Dockerfile" "$REPO_DIR"

    echo "[game-service] Pushing ${ECR_REPO_GAME}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-game-service:${DEPLOY_SHA}" "$NEW_IMAGE"
    docker push "$NEW_IMAGE" 2>&1 | tail -3

    echo "[game-service] Registering new task-def revision with image=:${DEPLOY_SHA}..."
    NEW_TD_ARN=$(register_new_task_def_with_image "$TD_FAMILY_GAME" "$NEW_IMAGE")
    echo "  task-def: $NEW_TD_ARN"

    echo "[game-service] Updating ECS service to new revision..."
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_GAME" \
        --task-definition "$NEW_TD_ARN" \
        --force-new-deployment --query 'service.deployments[0].status' --output text
    echo "  ECS service update initiated."

    echo "[game-service] Waiting for rollout to stabilize..."
    if ! aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_GAME"; then
        echo "  ERROR: services-stable timed out or failed. :latest NOT moved."
        echo "  Rollback: см. runbook в шапке deploy-aws.sh."
        exit 1
    fi
    echo "  Rollout stable."

    echo "[game-service] Atomic move ${ECR_REPO_GAME}:latest → :${DEPLOY_SHA}..."
    ecr_move_latest_to_tag "$ECR_REPO_GAME" "$DEPLOY_SHA"
fi

# --- Broadcast Service (apps/broadcast-service): docker build → ECR push под :<sha> →
#     migrate → update-service → services-stable → smoke → put-image :latest ---
# ADR-021: REST+WS для /broadcasts переезжает из apps/api в отдельный apps/broadcast-service
# на broadcasts.kingside.site. Образ kingside-broadcast-service обслуживает один ECS-сервис
# kingside-broadcast-service (HTTP+WS на порту 3004). Sticky sessions включены на ALB TG
# kingside-broadcasts-api (lb_cookie, WS-critical).
# Инфра — scripts/broadcast-service-aws-setup.sh (KS-1696).
if $DEPLOY_BROADCAST_SERVICE; then
    NEW_IMAGE="${ECR_URI_BROADCAST_SERVICE}:${DEPLOY_SHA}"

    echo "[broadcast-service] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null

    echo "[broadcast-service] Building Docker image (tag=$DEPLOY_SHA)..."
    docker build -t "kingside-broadcast-service:${DEPLOY_SHA}" -f "$REPO_DIR/apps/broadcast-service/Dockerfile" "$REPO_DIR"

    echo "[broadcast-service] Pushing ${ECR_REPO_BROADCAST_SERVICE}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-broadcast-service:${DEPLOY_SHA}" "$NEW_IMAGE"
    docker push "$NEW_IMAGE" 2>&1 | tail -3

    SVC_STATUS=$(aws ecs describe-services \
        --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE_BROADCAST_SERVICE" \
        --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")

    if [ "$SVC_STATUS" = "ACTIVE" ]; then
        echo "[broadcast-service] Registering new task-def revision with image=:${DEPLOY_SHA}..."
        NEW_TD_ARN=$(register_new_task_def_with_image "$TD_FAMILY_BROADCAST_SERVICE" "$NEW_IMAGE")
        echo "  task-def: $NEW_TD_ARN"

        # KS-1817: Prisma migrations для broadcasts-db (отдельная БД broadcasts_kingside).
        # До KS-1817 миграции этой БД накатывались вручную → 24.04 миграция 20260424093000
        # не приехала вместе с деплоем KS-1813 и /rounds падал 500.
        # KS-1826: migrate-run-task идёт на НОВУЮ revision (image :<sha>) — прод-сервисы
        # пока продолжают работать на предыдущей revision / предыдущем :latest.
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

        echo "[broadcast-service] Updating ECS service to new revision..."
        aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE_BROADCAST_SERVICE" \
            --task-definition "$NEW_TD_ARN" \
            --force-new-deployment --query 'service.deployments[0].status' --output text
        echo "  ECS service update initiated."

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
        echo "[broadcast-service] Smoke-check /rounds on broadcast $SMOKE_BROADCAST_ID..."
        SMOKE_CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "https://broadcasts.kingside.site/${SMOKE_BROADCAST_ID}/rounds" || echo "000")
        if [ "$SMOKE_CODE" != "200" ]; then
            echo "  ERROR: smoke /rounds returned $SMOKE_CODE (expected 200). Likely DB schema regression or service unavailable."
            echo "  :latest NOT moved — остаётся на предыдущем удачном digest."
            echo "  Rollback: см. runbook в шапке deploy-aws.sh."
            exit 1
        fi
        echo "  Smoke /rounds OK (HTTP 200)."

        echo "[broadcast-service] Atomic move ${ECR_REPO_BROADCAST_SERVICE}:latest → :${DEPLOY_SHA}..."
        ecr_move_latest_to_tag "$ECR_REPO_BROADCAST_SERVICE" "$DEPLOY_SHA"
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
# KS-1897: на проде используются 4 task-def family с этим образом — все обновляем.
#
# Семантика по семействам:
#   - kingside-archive-service           — ECS service (HTTP, /tree). update-service.
#   - kingside-archive-importer          — наследие; никем не используется. Только
#                                          register revision (синхронно с другими).
#   - kingside-archive-importer-oneshot  — EventBridge daily target. После
#                                          register обновляем target ARN расписания.
#   - kingside-archive-importer-adhoc    — adhoc batch / dev (ручной aws ecs run-task,
#                                          подхватывает свежий :latest). Только register.
if $DEPLOY_ARCHIVE_SERVICE; then
    NEW_IMAGE="${ECR_URI_ARCHIVE_SERVICE}:${DEPLOY_SHA}"

    echo "[archive-service] Logging in to ECR..."
    aws ecr get-login-password --region "$REGION" | \
        docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" 2>/dev/null

    echo "[archive-service] Building Docker image (tag=$DEPLOY_SHA)..."
    docker build -t "kingside-archive-service:${DEPLOY_SHA}" -f "$REPO_DIR/apps/archive-service/Dockerfile" "$REPO_DIR"

    echo "[archive-service] Pushing ${ECR_REPO_ARCHIVE_SERVICE}:${DEPLOY_SHA} to ECR..."
    docker tag "kingside-archive-service:${DEPLOY_SHA}" "$NEW_IMAGE"
    docker push "$NEW_IMAGE" 2>&1 | tail -3

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
    NEW_TD_IMPORTER_ARN="${NEW_TD_ARNS[$TD_FAMILY_ARCHIVE_IMPORTER]}"

    if [ "$ARCHIVE_SVC_STATUS" = "ACTIVE" ]; then
        # KS-1822: Prisma migrations для archive-db (отдельная БД archive_kingside,
        # ADR-018). Симметрично api- и broadcast-service-блокам (KS-1817).
        # Одного migrate-таска достаточно: все archive task-def family ездят на
        # одном образе и работают с одной БД (ADR-019).
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
fi

# Save deployed commit
save_deployed_commit

echo ""
echo "=== Deploy complete ($SCOPE) ==="
