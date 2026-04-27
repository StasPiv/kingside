#!/usr/bin/env bash
# KS-2033: однострочный SQL-доступ к archive RDS из VPC.
#
# RDS `kingside-archive-db` не публичный (private subnet, SG-allowed только из ECS-SG).
# Локально psql/pg недоступны. Скрипт упаковывает один Fargate ECS run-task на образе
# postgres:16-alpine, выполняет SQL и возвращает stdout.
#
# Использование:
#   scripts/archive-sql.sh "SELECT count(*) FROM archive_imports;"
#   echo "SELECT ..." | scripts/archive-sql.sh
#   scripts/archive-sql.sh -t main "SELECT count(*) FROM users;"  # на старый общий kingside
#   scripts/archive-sql.sh -t broadcasts "SELECT ...;"            # на broadcasts_kingside
#
# Опции:
#   -t TARGET   archive (default) | main | broadcasts
#   -d DBNAME   override database в URL (для main по умолчанию kingside, для broadcasts — broadcasts_kingside)
#   -h          help
#
# Время отклика: ~30–60 сек (старт Fargate task'а). Для повторных запросов
# держи открытый shell — переменные секрета кэшируются.

set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
CLUSTER="${ECS_CLUSTER:-kingside}"
SUBNETS="${ECS_SUBNETS:-subnet-0fcc377586c117002,subnet-0374b32497e079707}"
SECURITY_GROUPS="${ECS_SECURITY_GROUPS:-sg-07f96fdb66b70e8eb}"
TASK_FAMILY="${TASK_FAMILY:-kingside-archive-db-setup:1}"
LOG_GROUP="${LOG_GROUP:-/ecs/kingside-archive-db-setup}"
CONTAINER_NAME="${CONTAINER_NAME:-psql}"

TARGET="archive"
DB_OVERRIDE=""

usage() {
  sed -n '1,30p' "$0" | grep -E '^# ' | sed 's/^# \?//'
  exit 1
}

while getopts "t:d:h" opt; do
  case "$opt" in
    t) TARGET="$OPTARG" ;;
    d) DB_OVERRIDE="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))

# SQL: из аргумента или stdin
SQL="${1:-}"
if [ -z "$SQL" ] && [ ! -t 0 ]; then
  SQL="$(cat)"
fi
if [ -z "$SQL" ]; then
  echo "[archive-sql] error: SQL не передан (аргумент или stdin)" >&2
  usage
fi

# Resolve URL по target
case "$TARGET" in
  archive)
    SECRET_ID="kingside/archive-service"
    SECRET_KEY="ARCHIVE_DATABASE_URL"
    DEFAULT_DB="archive_kingside"
    ;;
  main)
    SECRET_ID="kingside/api"
    SECRET_KEY="DATABASE_URL"
    DEFAULT_DB="kingside"
    ;;
  broadcasts)
    SECRET_ID="kingside/api"
    SECRET_KEY="DATABASE_URL"
    DEFAULT_DB="broadcasts_kingside"
    ;;
  *)
    echo "[archive-sql] error: unknown -t target '$TARGET' (archive|main|broadcasts)" >&2
    exit 1
    ;;
esac

URL=$(aws secretsmanager get-secret-value \
  --region "$REGION" \
  --secret-id "$SECRET_ID" \
  --query SecretString --output text \
  | python3 -c "import json, sys; print(json.load(sys.stdin)['$SECRET_KEY'])")

# Подменяем database в URL если задан -d, либо для main/broadcasts применяем DEFAULT_DB
if [ -n "$DB_OVERRIDE" ]; then
  TARGET_DB="$DB_OVERRIDE"
else
  TARGET_DB="$DEFAULT_DB"
fi

# URL формат: postgresql://user:pass@host:port/dbname?sslmode=...
URL=$(python3 -c "
import sys, re
u = '$URL'
db = '$TARGET_DB'
m = re.match(r'(postgresql://[^/]+)/([^?]+)(\?.*)?$', u)
if m:
    print(f'{m.group(1)}/{db}{m.group(3) or \"\"}')
else:
    print(u, file=sys.stderr)
    sys.exit(1)
")

# Готовим overrides JSON через python (чтобы корректно эскейпить SQL и URL)
OVERRIDES=$(python3 <<PYEOF
import json, os
sql = """$SQL"""
url = "$URL"
container = "$CONTAINER_NAME"
out = {
  "containerOverrides": [
    {
      "name": container,
      "command": ["sh","-c","psql \"\$DB_URL\" -v ON_ERROR_STOP=1 -c \"\$DB_SQL\""],
      "environment": [
        {"name":"DB_URL","value":url},
        {"name":"DB_SQL","value":sql},
        {"name":"PGSSLMODE","value":"require"}
      ]
    }
  ]
}
print(json.dumps(out))
PYEOF
)

TMP=$(mktemp /tmp/archive-sql-XXXXXX.json)
echo "$OVERRIDES" > "$TMP"

ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" --region "$REGION" \
  --launch-type FARGATE \
  --task-definition "$TASK_FAMILY" \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SECURITY_GROUPS}],assignPublicIp=ENABLED}" \
  --overrides "file://$TMP" \
  --started-by 'archive-sql' \
  --query 'tasks[0].taskArn' --output text)

rm -f "$TMP"

TID=${ARN##*/}
echo "[archive-sql] task=$TID target=$TARGET db=$TARGET_DB" >&2

aws ecs wait tasks-stopped --cluster "$CLUSTER" --region "$REGION" --tasks "$TID"

EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --region "$REGION" --tasks "$TID" \
  --query 'tasks[0].containers[0].exitCode' --output text)
STOP_REASON=$(aws ecs describe-tasks --cluster "$CLUSTER" --region "$REGION" --tasks "$TID" \
  --query 'tasks[0].stoppedReason' --output text)

# Логи (с retry на случай отложенного создания stream'а)
STREAM="psql/${CONTAINER_NAME}/${TID}"
for attempt in 1 2 3; do
  LOGS=$(aws logs get-log-events --region "$REGION" \
    --log-group-name "$LOG_GROUP" \
    --log-stream-name "$STREAM" \
    --query 'events[*].message' --output text 2>/dev/null || echo "")
  [ -n "$LOGS" ] && break
  sleep 2
done

# Печатаем результат
echo "$LOGS" | tr '\t' '\n'

if [ "$EXIT_CODE" != "0" ] && [ "$EXIT_CODE" != "None" ]; then
  echo "[archive-sql] task exited with code $EXIT_CODE: $STOP_REASON" >&2
  exit "$EXIT_CODE"
fi
