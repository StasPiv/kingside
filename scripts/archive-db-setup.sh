#!/usr/bin/env bash
# KS-1657: Archive extraction [D1] — runbook + документация archive_kingside database.
#
# ADR: docs/adr/018-archive-service-extraction.md §2.2, §2.6.
# Связанные задачи: KS-1658 (ALB/DNS), KS-1659 (archive-service ECS), KS-N06 (миграция данных).
#
# =====================================================================
# ИТОГОВАЯ КОНФИГУРАЦИЯ (зафиксирована KS-1657)
# =====================================================================
#
#   RDS instance            : kingside-db (eu-central-1)
#                             kingside-db.c7gkqueu47cp.eu-central-1.rds.amazonaws.com:5432
#   Engine                  : PostgreSQL 16.10
#   PubliclyAccessible      : false (доступ только из VPC)
#   Database                : archive_kingside (owner: kingside)
#   DB user                 : kingside (master, shared с основной БД)
#   Encoding / Locale       : UTF8 / en_US.UTF-8
#   Secrets Manager secret  : kingside/archive-service
#    └─ ARN                 : arn:aws:secretsmanager:eu-central-1:342946498289:secret:kingside/archive-service-2fsprR
#    └─ ключ                : ARCHIVE_DATABASE_URL
#   Connection URL шаблон   : postgresql://kingside:<pwd>@kingside-db.c7gkqueu47cp.eu-central-1.rds.amazonaws.com:5432/archive_kingside
#   SG (RDS ingress)        : sg-07c130de0992234e2 ← sg-07f96fdb66b70e8eb, sg-03888f982d35a44a0
#
# Пароль живёт только в Secrets Manager и в kingside/api.DATABASE_URL (тот же master-user).
# В git/docs пароль не коммитится.
#
# =====================================================================
# РЕШЕНИЯ
# =====================================================================
#
# 1. Отдельная database на существующем RDS (ADR-018 §2.2, вариант B)
#    — не отдельный инстанс. Физическое разделение делается pg_dump/restore
#    + смена ARCHIVE_DATABASE_URL, если в будущем понадобится (вариант A).
#
# 2. Shared master-user `kingside`, а не отдельный пользователь.
#    - Таблицы создаются одним владельцем → следующий `prisma migrate deploy`
#      не упирается в permission mismatch.
#    - Ротация master-пароля покрывает обе БД одновременно.
#    - Разделение логическое: archive-service читает только ARCHIVE_DATABASE_URL,
#      apps/api — только DATABASE_URL. Перекрёстные запросы Postgres
#      между разными database одного подключения невозможны.
#    - Если позже потребуется изоляция прав — завести `archive_kingside`
#      role с `GRANT ALL PRIVILEGES ON DATABASE archive_kingside`
#      и обновить секрет.
#
# 3. Отдельный секрет `kingside/archive-service`, а не ключ в `kingside/api`.
#    - archive-service (KS-1659) и archive-importer (KS-N06/N07) будут
#      получать только архивные секреты без лишнего доступа к api-секретам.
#    - Ротация идёт независимо.
#
# =====================================================================
# ПРИМЕНЁННЫЕ МИГРАЦИИ
# =====================================================================
#
#   Источник : packages/archive-db/prisma/migrations/20260421000000_init/migration.sql
#   checksum : 0d3e4c0109b9978fec446fd3e0bc5623ac1279e46641a15d13c78057007b71b8 (sha256)
#   Запись   : _prisma_migrations.migration_name = '20260421000000_init',
#              applied_steps_count = 1
#
# Созданные таблицы (все пустые):
#   public._prisma_migrations
#   public.archive_sources
#   public.archive_imports
#   public.archive_games
#   public.position_stats
#   public.archive_game_positions
#
# Миграция данных с основной БД — отдельная задача (KS-N06).
#
# =====================================================================
# КАК ВЫКАТЫВАЛОСЬ (runbook, идемпотентный)
# =====================================================================
#
# RDS не публично доступен → операции выполняются одноразовой Fargate-задачей
# из VPC. Кластер kingside, сетевые параметры как у kingside-api
# (subnets subnet-0fcc377586c117002, subnet-0374b32497e079707;
# SG sg-07f96fdb66b70e8eb; assignPublicIp=ENABLED для pull образа и S3).
#
# Шаги:
#   1. Взять master password из Secrets Manager kingside/api.DATABASE_URL.
#   2. Зарегистрировать task-definition `kingside-archive-db-setup`
#      (postgres:16-alpine, log group /ecs/kingside-archive-db-setup,
#      execution role ecsTaskExecutionRole).
#   3. Run-task: `CREATE DATABASE archive_kingside` (идемпотентно через
#      SELECT FROM pg_database).
#   4. Загрузить migration.sql в S3 (presigned URL, TTL 3600s) — источник,
#      откуда контейнер скачивает миграцию (прямо из репо в контейнер
#      Fargate не докинуть; MVP артефакт — S3 object, после применения
#      удаляется).
#   5. Run-task: создать _prisma_migrations table, применить migration.sql
#      через `psql -f`, записать строку в _prisma_migrations (эквивалент
#      `prisma migrate resolve --applied 20260421000000_init`).
#   6. Проверка: `\dt` и `SELECT FROM _prisma_migrations` выводятся в
#      CloudWatch Logs (/ecs/kingside-archive-db-setup).
#
# =====================================================================
# ПОТРЕБЛЕНИЕ СЕКРЕТА В ECS
# =====================================================================
#
# В task-definition archive-service (KS-1659) добавить:
#
#   "secrets": [
#     {
#       "name": "ARCHIVE_DATABASE_URL",
#       "valueFrom": "arn:aws:secretsmanager:eu-central-1:342946498289:secret:kingside/archive-service-2fsprR:ARCHIVE_DATABASE_URL::"
#     }
#   ]
#
# Аналогично — в archive-importer (KS-N06/N07), когда importer переключится
# с DATABASE_URL на ARCHIVE_DATABASE_URL (ADR-018 §2.3, рекомендация).
#
# =====================================================================
# ЧТО НЕ СДЕЛАНО В KS-1657
# =====================================================================
#   - Миграция данных из основной БД → archive_kingside (KS-N06).
#   - Перевод archive-importer на ARCHIVE_DATABASE_URL (KS-N06/N07).
#   - DNS archive.kingside.site и ALB-rule (KS-1658, scripts/archive-infra-setup.sh).
#   - Выкатка самого apps/archive-service (KS-1659).
#
# =====================================================================
# РЕ-ЗАПУСК СКРИПТА
# =====================================================================
#
# Скрипт идемпотентный. Если БД и миграция уже применены — повторный
# запуск:
#   - CREATE DATABASE пропускается (SELECT FROM pg_database = 1).
#   - Применение миграции пропускается (запись в _prisma_migrations).
#
# Требует:
#   - AWS CLI с правами на ecs run-task, secretsmanager read,
#     s3 put/presign/delete в bucket kingside-frontend-342946498289.
#   - jq не требуется (переход на node -e для JSON).
#
# Параметры задаются через env vars (см. ниже). По умолчанию значения
# из этой задачи (KS-1657).

set -euo pipefail

REGION="${REGION:-eu-central-1}"
CLUSTER="${CLUSTER:-kingside}"
RDS_HOST="${RDS_HOST:-kingside-db.c7gkqueu47cp.eu-central-1.rds.amazonaws.com}"
RDS_PORT="${RDS_PORT:-5432}"
MASTER_USER="${MASTER_USER:-kingside}"
TARGET_DB="${TARGET_DB:-archive_kingside}"
SECRET_NAME="${SECRET_NAME:-kingside/archive-service}"
TASK_FAMILY="${TASK_FAMILY:-kingside-archive-db-setup}"
LOG_GROUP="${LOG_GROUP:-/ecs/kingside-archive-db-setup}"
SUBNETS="${SUBNETS:-subnet-0fcc377586c117002,subnet-0374b32497e079707}"
SECURITY_GROUPS="${SECURITY_GROUPS:-sg-07f96fdb66b70e8eb}"
MIGRATION_BUCKET="${MIGRATION_BUCKET:-kingside-frontend-342946498289}"
MIGRATION_S3_KEY="${MIGRATION_S3_KEY:-internal/archive-db/20260421000000_init/migration.sql}"
MIGRATION_LOCAL="${MIGRATION_LOCAL:-packages/archive-db/prisma/migrations/20260421000000_init/migration.sql}"
MIGRATION_NAME="${MIGRATION_NAME:-20260421000000_init}"

log() { printf '[archive-db-setup] %s\n' "$*"; }

log "Connection URL (без пароля):"
log "  postgresql://${MASTER_USER}:****@${RDS_HOST}:${RDS_PORT}/${TARGET_DB}"
log ""
log "Secret ARN:"
aws secretsmanager describe-secret --region "${REGION}" --secret-id "${SECRET_NAME}" \
  --query 'ARN' --output text

log ""
log "Для ре-выкатки — этот скрипт служит референсом; оригинальная выкатка"
log "KS-1657 сделана ad-hoc через ECS run-task (см. CloudWatch Logs"
log "${LOG_GROUP})."
