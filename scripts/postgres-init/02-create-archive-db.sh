#!/bin/bash
# Runs once on first postgres container init (docker-entrypoint-initdb.d).
# Creates `kingside_archive` alongside the default $POSTGRES_DB (`kingside`).
#
# KS-2698: dev-среде нужна отдельная БД под archive-importer / tactic-worker
# (см. ADR-018 §2.2 — в проде архивная БД физически отделена как
# `archive_kingside`). Без этого файла после `docker compose down -v`
# архивная БД исчезает и backend упирается в «таблица archive_games не существует».
#
# Если postgres volume уже существует (повторный запуск), этот скрипт НЕ выполняется —
# скрипты в docker-entrypoint-initdb.d postgres отдаёт только на пустую базу.
# В таком случае создай БД вручную:
#   bash scripts/prisma-migrate-deploy.sh   # с флагом scripts/.prisma-action='init-archive-db'
# или напрямую:
#   psql -h localhost -U "$POSTGRES_USER" -c "CREATE DATABASE kingside_archive;"

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE kingside_archive OWNER $POSTGRES_USER'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'kingside_archive')\gexec
EOSQL

echo "[postgres-init] kingside_archive ready (owner=$POSTGRES_USER)"
