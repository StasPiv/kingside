-- KS-2760: настройка postgres_fdw для JOIN из main БД `kingside` в `kingside_archive.archive_games`.
-- Используется одноразовым сервисом `fdw-setup-local` в docker-compose.yml.
-- Идемпотентно: всё через IF NOT EXISTS / DO-блоки.
--
-- Внутри postgres-контейнера archive БД — соседняя БД в том же инстансе,
-- доступна через TCP loopback к самому себе (host='postgres' — docker DNS на сервис).

\set ON_ERROR_STOP on

\echo === main DB (kingside): extension + server + mapping + foreign table ===

CREATE EXTENSION IF NOT EXISTS postgres_fdw;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname='archive_srv') THEN
    CREATE SERVER archive_srv
      FOREIGN DATA WRAPPER postgres_fdw
      OPTIONS (host 'postgres', dbname 'kingside_archive', port '5432');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_user_mappings WHERE srvname='archive_srv' AND usename=current_user) THEN
    EXECUTE format(
      'CREATE USER MAPPING FOR %I SERVER archive_srv OPTIONS (user %L, password %L)',
      current_user, 'kingside', 'kingside'
    );
  END IF;
END$$;

CREATE FOREIGN TABLE IF NOT EXISTS archive_games_remote (
  id        UUID,
  white_elo INT,
  black_elo INT
)
  SERVER archive_srv
  OPTIONS (schema_name 'public', table_name 'archive_games');

GRANT SELECT ON archive_games_remote TO kingside;

\echo === sanity main ===
SELECT 'fdw_ext' AS what, count(*)::int FROM pg_extension WHERE extname='postgres_fdw'
UNION ALL SELECT 'server',  count(*)::int FROM pg_foreign_server WHERE srvname='archive_srv'
UNION ALL SELECT 'mapping', count(*)::int FROM pg_user_mappings WHERE srvname='archive_srv'
UNION ALL SELECT 'ftable',  count(*)::int FROM information_schema.foreign_tables WHERE foreign_table_name='archive_games_remote';
