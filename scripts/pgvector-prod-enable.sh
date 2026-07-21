#!/usr/bin/env bash
# KS-4992 / ADR-169 §4: включить расширение pgvector (`vector`) на прод RDS.
#
# Прод RDS не публично доступен → DDL выполняется одноразовой Fargate-задачей из
# VPC (тот же приём, что scripts/archive-db-setup.sh). Мастер-креды берутся из
# Secrets Manager (kingside/api: DATABASE_URL, ARCHIVE_DATABASE_URL) и внедряются
# как ECS-secrets в task-definition — run-task не умеет добавлять secrets через
# override, поэтому нужна отдельная ревизия task-def.
#
# Две прод-инстанции RDS:
#   - kingside-db          → БД kingside          (DATABASE_URL)
#   - kingside-archive-db  → БД archive_kingside  (ARCHIVE_DATABASE_URL)
# Расширение включается на ОБЕИХ (идемпотентно), т.к. таблицу position_embedding
# backend разместит отдельной задачей; корпус (archive_position_stats) — в archive.
#
# Идемпотентно: CREATE EXTENSION IF NOT EXISTS. Повторный запуск безопасен.
# Требует прав ecs register-task-definition/run-task, secretsmanager read,
# logs read (у kingside-ci есть).
set -euo pipefail

REGION="${REGION:-eu-central-1}"
CLUSTER="${CLUSTER:-kingside}"
FAMILY="${FAMILY:-kingside-pgvector-setup}"
LOG_GROUP="${LOG_GROUP:-/ecs/kingside-archive-db-setup}"
EXEC_ROLE="${EXEC_ROLE:-arn:aws:iam::342946498289:role/ecsTaskExecutionRole}"
SECRET_ARN="${SECRET_ARN:-arn:aws:secretsmanager:eu-central-1:342946498289:secret:kingside/api-nfkTKX}"
SUBNETS="${SUBNETS:-subnet-0fcc377586c117002,subnet-0374b32497e079707}"
SECURITY_GROUPS="${SECURITY_GROUPS:-sg-07f96fdb66b70e8eb}"
export AWS_PAGER=""

log() { printf '[pgvector-prod-enable] %s\n' "$*"; }

# psql-скрипт, исполняемый в контейнере. Выводит версию extension после создания.
CMD='set -eu
echo "=== main (DATABASE_URL) ==="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "SELECT current_database() AS db, extname, extversion FROM pg_extension WHERE extname = '"'"'vector'"'"';"
echo "=== archive (ARCHIVE_DATABASE_URL) ==="
psql "$ARCHIVE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "SELECT current_database() AS db, extname, extversion FROM pg_extension WHERE extname = '"'"'vector'"'"';"
echo "=== pgvector-prod-enable DONE ==="'

log "register task-definition ${FAMILY} (secrets: DATABASE_URL, ARCHIVE_DATABASE_URL)"
CONTAINERS=$(cat <<JSON
[{
  "name": "psql",
  "image": "postgres:16-alpine",
  "essential": true,
  "command": ["sh","-c",$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$CMD")],
  "secrets": [
    {"name":"DATABASE_URL","valueFrom":"${SECRET_ARN}:DATABASE_URL::"},
    {"name":"ARCHIVE_DATABASE_URL","valueFrom":"${SECRET_ARN}:ARCHIVE_DATABASE_URL::"}
  ],
  "logConfiguration": {
    "logDriver":"awslogs",
    "options":{"awslogs-group":"${LOG_GROUP}","awslogs-region":"${REGION}","awslogs-stream-prefix":"pgvector"}
  }
}]
JSON
)

TD_ARN=$(aws ecs register-task-definition --region "$REGION" \
  --family "$FAMILY" --requires-compatibilities FARGATE --network-mode awsvpc \
  --cpu 256 --memory 512 --execution-role-arn "$EXEC_ROLE" \
  --container-definitions "$CONTAINERS" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
log "registered: $TD_ARN"

log "run-task"
TASK_ARN=$(aws ecs run-task --region "$REGION" --cluster "$CLUSTER" \
  --launch-type FARGATE --task-definition "$TD_ARN" \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SECURITY_GROUPS}],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)
log "task: $TASK_ARN"

log "waiting for task to stop..."
aws ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK_ARN"

EXIT=$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)
REASON=$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' --output text)
log "exitCode=$EXIT stoppedReason=$REASON"

TASK_ID="${TASK_ARN##*/}"
log "--- CloudWatch logs (${LOG_GROUP}/pgvector/psql/${TASK_ID}) ---"
aws logs get-log-events --region "$REGION" --log-group-name "$LOG_GROUP" \
  --log-stream-name "pgvector/psql/${TASK_ID}" --start-from-head \
  --query 'events[].message' --output text 2>/dev/null || log "(логи ещё не подтянулись; повторить get-log-events позже)"

[ "$EXIT" = "0" ] || { log "FAILED (exitCode=$EXIT)"; exit 1; }
log "OK"
