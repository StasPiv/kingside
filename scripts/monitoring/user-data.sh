#!/bin/bash
# EC2 user-data для kingside-monitoring (KS-1638).
# Выполняется один раз при первом запуске инстанса (Amazon Linux 2023).
#
# Что делает:
#   1. Устанавливает docker и docker-compose-plugin.
#   2. Скачивает tarball с конфигами из S3 (kingside-frontend-<acct>/monitoring/configs.tar.gz).
#   3. Получает секреты из AWS Secrets Manager (kingside/api).
#   4. Формирует .env с параметрами Postgres, Telegram, Grafana.
#   5. Запускает docker compose --file compose.monitoring.yml up -d.
#
# Требования к IAM-роли EC2 (kingside-monitoring-ec2):
#   - AmazonSSMManagedInstanceCore (SSM Session Manager доступ).
#   - secretsmanager:GetSecretValue на secret kingside/api.
#   - s3:GetObject на bucket kingside-frontend-342946498289 prefix monitoring/.
#   - ecs:ListTasks, ecs:DescribeTasks (для ecs-discovery sidecar — aws cli внутри контейнера
#     наследует IAM роль через IMDSv2).

set -euxo pipefail

REGION="${AWS_REGION:-eu-central-1}"
BUCKET="kingside-frontend-342946498289"
CONFIGS_KEY="monitoring/configs.tar.gz"
TELEGRAM_CHAT_ID_FALLBACK="308433890"  # FEEDBACK_TELEGRAM_CHAT_ID из ECS task env
APP_DIR="/opt/kingside-monitoring"

exec > >(tee -a /var/log/kingside-monitoring-bootstrap.log) 2>&1
echo "[$(date -u +%FT%TZ)] bootstrap start"

# 1. Docker
dnf update -y
dnf install -y docker jq awscli
systemctl enable --now docker
usermod -aG docker ec2-user

# 2. docker compose plugin
DOCKER_PLUGINS=/usr/libexec/docker/cli-plugins
mkdir -p "$DOCKER_PLUGINS"
COMPOSE_VERSION="v2.29.7"
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" \
    -o "$DOCKER_PLUGINS/docker-compose"
chmod +x "$DOCKER_PLUGINS/docker-compose"
docker compose version

# 3. Configs
mkdir -p "$APP_DIR"
cd "$APP_DIR"
aws s3 cp "s3://${BUCKET}/${CONFIGS_KEY}" /tmp/configs.tar.gz --region "$REGION"
tar -xzf /tmp/configs.tar.gz -C "$APP_DIR"

# 4. Secrets from Secrets Manager
SECRETS_JSON=$(aws secretsmanager get-secret-value \
    --secret-id kingside/api \
    --region "$REGION" \
    --query SecretString --output text)

TELEGRAM_BOT_TOKEN=$(echo "$SECRETS_JSON" | jq -r '.TELEGRAM_BOT_TOKEN // empty')
DATABASE_URL=$(echo "$SECRETS_JSON" | jq -r '.DATABASE_URL // empty')

if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$DATABASE_URL" ]; then
    echo "FATAL: TELEGRAM_BOT_TOKEN or DATABASE_URL missing in secret kingside/api" >&2
    exit 1
fi

# 5. Parse DATABASE_URL (postgresql://user:password@host:port/db) -> components для datasource.
# Учитываем спецсимволы в пароле (url-encoded или raw).
PG_PROTO_STRIPPED="${DATABASE_URL#postgresql://}"
PG_CREDS="${PG_PROTO_STRIPPED%%@*}"
PG_HOSTDB="${PG_PROTO_STRIPPED#*@}"
PG_USER="${PG_CREDS%%:*}"
PG_PASSWORD="${PG_CREDS#*:}"
PG_HOSTPORT="${PG_HOSTDB%%/*}"
PG_DB="${PG_HOSTDB#*/}"
PG_DB="${PG_DB%%\?*}"   # срезаем query-string если есть
PG_HOST="${PG_HOSTPORT%%:*}"

# Для postgres-exporter — DSN с sslmode=require (RDS требует TLS).
POSTGRES_EXPORTER_DSN="${DATABASE_URL}?sslmode=require"

# 6. Генерируем пароль Grafana admin (случайный, сохраняется в SSM для повторного доступа).
GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 20)
aws ssm put-parameter \
    --name /kingside/monitoring/grafana_admin_password \
    --type SecureString \
    --value "$GRAFANA_ADMIN_PASSWORD" \
    --overwrite \
    --region "$REGION" || echo "WARN: ssm put-parameter failed (may lack permission), password only in .env"

# 7. .env
cat > "$APP_DIR/.env" <<EOF
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-$TELEGRAM_CHAT_ID_FALLBACK}
POSTGRES_EXPORTER_DATA_SOURCE_NAME=${POSTGRES_EXPORTER_DSN}
POSTGRES_HOST=${PG_HOST}
POSTGRES_DB=${PG_DB}
POSTGRES_USER=${PG_USER}
POSTGRES_PASSWORD=${PG_PASSWORD}
POSTGRES_SSLMODE=require
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
AWS_REGION=${REGION}
ECS_CLUSTER=kingside
ECS_SERVICE=kingside-api
EOF
chmod 600 "$APP_DIR/.env"
chown -R ec2-user:ec2-user "$APP_DIR"

# 8. Compose up
cd "$APP_DIR"
docker compose -f compose.monitoring.yml --env-file .env pull
docker compose -f compose.monitoring.yml --env-file .env up -d

# 9. Systemd-unit для автозапуска при ребуте
cat > /etc/systemd/system/kingside-monitoring.service <<EOF
[Unit]
Description=Kingside Monitoring Stack (Prometheus/Alertmanager/Grafana)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/docker compose -f compose.monitoring.yml up -d
ExecStop=/usr/bin/docker compose -f compose.monitoring.yml down

[Install]
WantedBy=multi-user.target
EOF
systemctl enable kingside-monitoring.service

echo "[$(date -u +%FT%TZ)] bootstrap done: Prometheus :9090, Alertmanager :9093, Grafana :3000"
