#!/bin/bash
# Runs once on first postgres container init (docker-entrypoint-initdb.d).
# Создаёт расширения, которые prisma-миграции ожидают предустановленными
# (на RDS их создаёт devops руками, у prisma-роли нет SUPERUSER).
#
# pg_trgm — нужен миграции KS-3234 (GIN trgm-индекс на puzzles.themes).
# postgres_fdw — нужен setup-fdw-local.sql и связке с archive-db.
#
# Скрипт выполняется внутри docker-entrypoint-initdb.d superuser-ом postgres,
# поэтому CREATE EXTENSION разрешён.

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS postgres_fdw;
EOSQL

echo "[postgres-init] extensions ready (pg_trgm, postgres_fdw) in $POSTGRES_DB"
