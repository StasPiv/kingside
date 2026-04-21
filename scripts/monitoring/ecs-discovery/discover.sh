#!/bin/bash
# ECS Service Discovery for Prometheus — self-hosted analog of prometheus-ecs-discovery.
# Координатор в KS-1638 указал: публичный ALB скрейпить нельзя — per-process counters
# balance'ятся между инстансами, получишь случайные слайсы. Поэтому каждые 60 секунд
# читаем ECS API и генерируем файл /targets/kingside-api.json с внутренними IP ENI'ев.
#
# Требования к IAM-роли EC2:
#   ecs:ListTasks, ecs:DescribeTasks, ec2:DescribeNetworkInterfaces.
# Без них скрипт логирует ошибку и продолжает — Prometheus просто покажет 0 target'ов.

set -eu

CLUSTER="${ECS_CLUSTER:-kingside}"
SERVICE="${ECS_SERVICE:-kingside-api}"
PORT="${TARGET_PORT:-3001}"
JOB="${TARGET_JOB:-kingside-api}"
METRICS_PATH="${TARGET_METRICS_PATH:-/api/metrics}"
INTERVAL="${INTERVAL:-60}"
OUT_DIR="/targets"
OUT_FILE="${OUT_DIR}/${JOB}.json"
TMP_FILE="${OUT_FILE}.tmp"

mkdir -p "$OUT_DIR"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

generate_targets() {
    local list_out task_arns tasks_raw targets_json count

    # 1. Собираем ARN'ы running tasks.
    if ! list_out=$(aws ecs list-tasks \
            --cluster "$CLUSTER" \
            --service-name "$SERVICE" \
            --desired-status RUNNING \
            --query 'taskArns' --output json 2>&1); then
        log "WARN: list-tasks failed: $list_out"
        echo "[]" > "$TMP_FILE"
        mv "$TMP_FILE" "$OUT_FILE"
        return 0
    fi

    task_arns=$(echo "$list_out" | jq -r '.[]? // empty' 2>/dev/null || true)
    if [ -z "$task_arns" ]; then
        log "no running tasks for $CLUSTER/$SERVICE — writing empty targets"
        echo "[]" > "$TMP_FILE"
        mv "$TMP_FILE" "$OUT_FILE"
        return 0
    fi

    # 2. describe-tasks отдаёт полную JSON-структуру; парсинг целиком в jq.
    if ! tasks_raw=$(aws ecs describe-tasks \
            --cluster "$CLUSTER" \
            --tasks $task_arns \
            --output json 2>&1); then
        log "WARN: describe-tasks failed: $tasks_raw"
        echo "[]" > "$TMP_FILE"
        mv "$TMP_FILE" "$OUT_FILE"
        return 0
    fi

    # 3. jq-фильтр: RUNNING + есть privateIPv4Address в ElasticNetworkInterface.
    targets_json=$(echo "$tasks_raw" | jq --arg port "$PORT" --arg job "$JOB" --arg mp "$METRICS_PATH" '
        [
          .tasks[]?
          | select(.lastStatus == "RUNNING")
          | . as $t
          | ($t.attachments[]?
              | select(.type == "ElasticNetworkInterface")
              | .details[]?
              | select(.name == "privateIPv4Address")
              | .value) as $ip
          | select($ip != null and $ip != "")
          | {
              targets: ["\($ip):\($port)"],
              labels: {
                job: $job,
                __metrics_path__: $mp,
                task_arn: $t.taskArn,
                ecs_health: ($t.healthStatus // "UNKNOWN")
              }
            }
        ]
    ')

    echo "$targets_json" > "$TMP_FILE"
    mv "$TMP_FILE" "$OUT_FILE"
    count=$(echo "$targets_json" | jq 'length')
    log "wrote $count target(s) to $OUT_FILE"
}

log "ecs-discovery start: cluster=$CLUSTER service=$SERVICE port=$PORT interval=${INTERVAL}s"

while true; do
    generate_targets || log "WARN: generate_targets iteration failed"
    sleep "$INTERVAL"
done
