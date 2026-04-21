#!/usr/bin/env bash
# KS-1661: Archive extraction [M1] cutover orchestrator.
#
# Регистрирует одноразовый task definition kingside-cutover-tools (postgres:16-alpine
# + aws-cli) и запускает на нём ECS RunTask, который:
#   1. Проверяет pg_stat_activity — нет ли активных INSERT в archive_*.
#   2. Фиксирует pg_total_relation_size + COUNT(*) по 5 таблицам в исходной БД.
#   3. pg_dump --data-only -Fc 5 таблиц → pipe в aws s3 cp → S3.
#   4. aws s3 cp из S3 → pipe в pg_restore --data-only → archive DB.
#   5. COUNT(*) по 5 таблицам в archive DB (должны совпадать с источником).
#   6. Ресинхронизация sequences в target DB.
#
# Вызов: bash scripts/archive-cutover.sh run
#        bash scripts/archive-cutover.sh register   # только (пере)регистрация task-def
#
# Поскольку в контейнере агента нет python3/jq, entrypoint-скрипт для контейнера
# загружается в S3 и стягивается оттуда после установки aws-cli.

set -euo pipefail

REGION="${REGION:-eu-central-1}"
ACCOUNT_ID="${ACCOUNT_ID:-342946498289}"
CLUSTER="${CLUSTER:-kingside}"
TASK_FAMILY="${TASK_FAMILY:-kingside-cutover-tools}"
LOG_GROUP="${LOG_GROUP:-/ecs/kingside-cutover-tools}"
S3_BUCKET="${S3_BUCKET:-kingside-archive-backups}"
S3_PREFIX="${S3_PREFIX:-cutover/$(date -u +%Y%m%dT%H%M%SZ)}"
S3_DUMP_KEY="${S3_PREFIX}/archive-tables.pgdump"
S3_SCRIPT_KEY="${S3_PREFIX}/entrypoint.sh"
API_SECRET_ARN="${API_SECRET_ARN:-arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:kingside/api-nfkTKX}"
ARCHIVE_SECRET_ARN="${ARCHIVE_SECRET_ARN:-arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:kingside/archive-service-2fsprR}"
SUBNETS="${SUBNETS:-subnet-0fcc377586c117002,subnet-0374b32497e079707}"
SG="${SG:-sg-07f96fdb66b70e8eb}"
IMAGE="${IMAGE:-public.ecr.aws/docker/library/postgres:16-alpine}"

aws_cli() { aws --region "${REGION}" "$@"; }
log() { printf '[cutover] %s\n' "$*"; }

register_taskdef() {
    TASKDEF_JSON=$(cat <<EOF
{
  "family": "${TASK_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskRole",
  "containerDefinitions": [
    {
      "name": "cutover",
      "image": "${IMAGE}",
      "essential": true,
      "environment": [
        {"name": "AWS_DEFAULT_REGION", "value": "${REGION}"}
      ],
      "secrets": [
        {"name": "DATABASE_URL",         "valueFrom": "${API_SECRET_ARN}:DATABASE_URL::"},
        {"name": "ARCHIVE_DATABASE_URL", "valueFrom": "${ARCHIVE_SECRET_ARN}:ARCHIVE_DATABASE_URL::"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${LOG_GROUP}",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
EOF
)
    TASKDEF_FILE="$(mktemp -t cutover-taskdef.XXXXXX.json)"
    trap 'rm -f "${TASKDEF_FILE}"' EXIT
    printf '%s' "${TASKDEF_JSON}" > "${TASKDEF_FILE}"
    TD_ARN=$(aws_cli ecs register-task-definition --cli-input-json "file://${TASKDEF_FILE}" \
        --query 'taskDefinition.taskDefinitionArn' --output text)
    log "registered task definition: ${TD_ARN}"
    printf '%s' "${TD_ARN}"
}

write_entrypoint() {
    ENTRYPOINT_FILE="$1"
    cat > "${ENTRYPOINT_FILE}" <<'ENTRY_EOF'
#!/bin/sh
set -eo pipefail

echo "[cutover] === stage 1: pg_stat_activity check (source DB) ==="
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "
SELECT pid, usename, application_name, state, query_start, LEFT(query, 120) AS query
FROM pg_stat_activity
WHERE query ILIKE '%archive_%'
  AND state <> 'idle'
  AND pid <> pg_backend_pid();
"

echo "[cutover] === stage 2: BEFORE - sizes & counts in SOURCE DB ==="
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "
SELECT relname,
       pg_size_pretty(pg_total_relation_size(relname::regclass)) AS total_size,
       pg_total_relation_size(relname::regclass)                  AS total_bytes
FROM (VALUES ('archive_sources'),
             ('archive_imports'),
             ('archive_games'),
             ('position_stats'),
             ('archive_game_positions')) AS t(relname);
"

psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "
SELECT 'archive_sources'        AS t, COUNT(*) FROM archive_sources
UNION ALL SELECT 'archive_imports',         COUNT(*) FROM archive_imports
UNION ALL SELECT 'archive_games',           COUNT(*) FROM archive_games
UNION ALL SELECT 'position_stats',          COUNT(*) FROM position_stats
UNION ALL SELECT 'archive_game_positions',  COUNT(*) FROM archive_game_positions;
"

echo "[cutover] === stage 3: pg_dump -> S3 s3://${S3_BUCKET}/${S3_DUMP_KEY} ==="
pg_dump --data-only --no-owner --no-privileges -Fc \
    -t archive_sources \
    -t archive_imports \
    -t archive_games \
    -t position_stats \
    -t archive_game_positions \
    "${DATABASE_URL}" \
    | aws s3 cp - "s3://${S3_BUCKET}/${S3_DUMP_KEY}" --expected-size 0

echo "[cutover] S3 object info:"
aws s3api head-object --bucket "${S3_BUCKET}" --key "${S3_DUMP_KEY}"

echo "[cutover] === stage 4: pg_restore <- S3 ==="
aws s3 cp "s3://${S3_BUCKET}/${S3_DUMP_KEY}" - \
    | pg_restore --data-only --no-owner --no-privileges --exit-on-error \
        -d "${ARCHIVE_DATABASE_URL}"

echo "[cutover] === stage 5: AFTER - counts in TARGET (archive) DB ==="
psql "${ARCHIVE_DATABASE_URL}" -v ON_ERROR_STOP=1 -c "
SELECT 'archive_sources'        AS t, COUNT(*) FROM archive_sources
UNION ALL SELECT 'archive_imports',         COUNT(*) FROM archive_imports
UNION ALL SELECT 'archive_games',           COUNT(*) FROM archive_games
UNION ALL SELECT 'position_stats',          COUNT(*) FROM position_stats
UNION ALL SELECT 'archive_game_positions',  COUNT(*) FROM archive_game_positions;
"

echo "[cutover] === stage 6: sequences resync in TARGET DB ==="
# После COPY последовательности не обновляются. Выставляем в MAX(id),
# чтобы INSERT'ы importer'а не упали на дубликате PK.
psql "${ARCHIVE_DATABASE_URL}" -v ON_ERROR_STOP=1 -c "
DO \$\$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT
      c.oid::regclass::text          AS tbl,
      a.attname                      AS col,
      pg_get_serial_sequence(c.oid::regclass::text, a.attname) AS seq
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relname IN ('archive_sources','archive_imports','archive_games',
                        'position_stats','archive_game_positions')
      AND pg_get_serial_sequence(c.oid::regclass::text, a.attname) IS NOT NULL
  LOOP
    EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I), 1), (SELECT MAX(%I) FROM %I) IS NOT NULL)',
                   r.seq, r.col, r.tbl, r.col, r.tbl);
    RAISE NOTICE 'resync % (%.%)', r.seq, r.tbl, r.col;
  END LOOP;
END
\$\$;
"

echo "[cutover] === done ==="
ENTRY_EOF
    chmod +x "${ENTRYPOINT_FILE}"
}

run_task() {
    TD_ARN="$1"

    # 1. Положить entrypoint в S3.
    ENTRY_FILE="$(mktemp -t cutover-entrypoint.XXXXXX.sh)"
    write_entrypoint "${ENTRY_FILE}"
    aws_cli s3 cp "${ENTRY_FILE}" "s3://${S3_BUCKET}/${S3_SCRIPT_KEY}" >/dev/null
    rm -f "${ENTRY_FILE}"
    log "entrypoint uploaded: s3://${S3_BUCKET}/${S3_SCRIPT_KEY}"

    # 2. Короткий bootstrap: ставим aws-cli, скачиваем entrypoint, запускаем.
    BOOTSTRAP="set -e; apk add --no-cache aws-cli >/dev/null; aws s3 cp s3://${S3_BUCKET}/${S3_SCRIPT_KEY} /tmp/entry.sh >/dev/null; chmod +x /tmp/entry.sh; S3_BUCKET=${S3_BUCKET} S3_DUMP_KEY=${S3_DUMP_KEY} sh /tmp/entry.sh"

    # 3. Собираем overrides.json вручную (без python).
    OVERRIDES_FILE="$(mktemp -t cutover-overrides.XXXXXX.json)"
    trap 'rm -f "${OVERRIDES_FILE}"' EXIT

    # Экранируем BOOTSTRAP для JSON: заменяем \ → \\ и " → \".
    ESC=$(printf '%s' "${BOOTSTRAP}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')

    cat > "${OVERRIDES_FILE}" <<JSON
{
  "containerOverrides": [
    {
      "name": "cutover",
      "command": ["sh", "-c", "${ESC}"]
    }
  ]
}
JSON

    log "RunTask → cluster=${CLUSTER} td=${TD_ARN}"
    log "S3 dump target: s3://${S3_BUCKET}/${S3_DUMP_KEY}"

    TASK_ARN=$(aws_cli ecs run-task \
        --cluster "${CLUSTER}" \
        --launch-type FARGATE \
        --platform-version LATEST \
        --task-definition "${TD_ARN}" \
        --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG}],assignPublicIp=ENABLED}" \
        --overrides "file://${OVERRIDES_FILE}" \
        --query 'tasks[0].taskArn' --output text)

    log "task started: ${TASK_ARN}"
    TASK_ID="${TASK_ARN##*/}"
    log "log stream: ${LOG_GROUP} → ecs/cutover/${TASK_ID}"

    aws_cli ecs wait tasks-stopped --cluster "${CLUSTER}" --tasks "${TASK_ARN}"

    TASK_JSON=$(aws_cli ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" --output json)
    EXIT_CODE=$(printf '%s' "${TASK_JSON}" | grep -oE '"exitCode":[ ]*[0-9-]+' | head -1 | sed 's/[^0-9-]//g' || true)
    STOP_CODE=$(printf '%s' "${TASK_JSON}" | sed -n 's/.*"stopCode":[ ]*"\([^"]*\)".*/\1/p' | head -1)
    STOP_REASON=$(printf '%s' "${TASK_JSON}" | sed -n 's/.*"stoppedReason":[ ]*"\([^"]*\)".*/\1/p' | head -1)

    log "task stopped. exitCode=${EXIT_CODE} stopCode=${STOP_CODE} reason=${STOP_REASON}"
    log "logs: aws --region ${REGION} logs tail ${LOG_GROUP} --log-stream-names ecs/cutover/${TASK_ID}"

    echo "${TASK_ID}" > /tmp/cutover-task-id
    echo "s3://${S3_BUCKET}/${S3_DUMP_KEY}" > /tmp/cutover-dump-uri
    echo "${TASK_ARN}" > /tmp/cutover-task-arn

    if [ "${EXIT_CODE}" != "0" ]; then
        log "ERROR: non-zero exit code. Fetching logs..."
        aws_cli logs tail "${LOG_GROUP}" --log-stream-names "ecs/cutover/${TASK_ID}" --since 1h || true
        exit 1
    fi
}

case "${1:-run}" in
    register)
        register_taskdef
        ;;
    run)
        TD_ARN=$(register_taskdef | tail -1)
        run_task "${TD_ARN}"
        ;;
    *)
        echo "usage: $0 [register|run]" >&2
        exit 2
        ;;
esac
