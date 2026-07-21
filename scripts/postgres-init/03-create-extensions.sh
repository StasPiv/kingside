#!/bin/bash
# Runs once on first postgres container init (docker-entrypoint-initdb.d).
# Создаёт расширения, которые prisma-миграции ожидают предустановленными
# (на RDS их создаёт devops руками, у prisma-роли нет SUPERUSER).
#
# pg_trgm — нужен миграции KS-3234 (GIN trgm-индекс на puzzles.themes).
# postgres_fdw — нужен setup-fdw-local.sql и связке с archive-db.
# vector (pgvector) — KS-4992 / ADR-169 §4: векторный поиск похожих позиций.
#   Требует образ pgvector/pgvector:pg16 (см. docker-compose.yml postgres).
#
# Скрипт выполняется внутри docker-entrypoint-initdb.d superuser-ом postgres,
# поэтому CREATE EXTENSION разрешён.
#
# vector создаётся и в основной БД, и в kingside_archive (02-create-archive-db.sh):
# корпус позиций (archive_position_stats) живёт в archive-БД, таблицу
# position_embedding backend создаёт отдельной миграцией — расширение должно быть
# доступно там, где backend решит её разместить.

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS postgres_fdw;
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "kingside_archive" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

echo "[postgres-init] extensions ready (pg_trgm, postgres_fdw, vector) in $POSTGRES_DB; vector in kingside_archive"
