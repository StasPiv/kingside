#!/bin/bash
# Runs once on first postgres container init (docker-entrypoint-initdb.d).
# Creates `broadcasts_kingside` alongside the default $POSTGRES_DB (`kingside`).
#
# KS-1744: dev-среде нужна отдельная БД под broadcast-service (ADR-021).
# Если postgres volume уже существует (повторный запуск), этот скрипт НЕ выполняется —
# скриптам в docker-entrypoint-initdb.d postgres отдаёт только на пустую базу.
# В таком случае создай БД вручную: psql -h localhost -U "$POSTGRES_USER" -c "CREATE DATABASE broadcasts_kingside;"
# или docker compose down -v && docker compose up -d (потеря данных!).

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE broadcasts_kingside OWNER $POSTGRES_USER'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'broadcasts_kingside')\gexec
EOSQL

echo "[postgres-init] broadcasts_kingside ready (owner=$POSTGRES_USER)"
