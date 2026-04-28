-- KS-2093: GIN pg_trgm индексы на substring-фильтры archive_games.
--
-- Контекст. `MetadataSqlBuilder` (apps/archive-service) формирует WHERE
-- следующего вида:
--   - `g.white_name ILIKE '%X%'`
--   - `g.black_name ILIKE '%X%'`
--   - `g.event ILIKE '%X%'`
--   - `(g.white_name ILIKE '%X%' OR g.black_name ILIKE '%X%')` — для
--     ?player=X (KS-2081), и AND блоки при массиве.
--
-- Существующие индексы:
--   - archive_games_played_at_idx (sort=recent / oldest)
--   - archive_games_top_elo_idx   (sort=topElo, GREATEST(...))
--   - archive_games_white_name_black_name_idx — обычный btree по
--     (white_name, black_name): для substring-ILIKE НЕ используется.
--
-- На корпусе ~6M партий substring-ILIKE без trgm идёт sequential scan,
-- что совпадает с пользовательской жалобой «поиск всё ещё медленный»
-- после KS-2090. pg_trgm extension уже включён в KS-2064.
--
-- CONCURRENTLY обязательно: archive_games — большая prod-таблица,
-- ACCESS EXCLUSIVE lock на минуты-десятки минут недопустим.
--
-- Prisma migrate deploy выполняет statement'ы PostgreSQL-миграций
-- вне явной транзакции (auto-commit), что совместимо с CONCURRENTLY.
-- Если по какой-то причине Prisma в окружении завернёт миграцию в
-- BEGIN/COMMIT — devops применяет SQL ниже вручную через psql:
--   `psql $ARCHIVE_DATABASE_URL -f migration.sql`
-- IF NOT EXISTS — идемпотентность для повторного применения.

CREATE INDEX CONCURRENTLY IF NOT EXISTS archive_games_white_name_trgm
  ON archive_games USING gin (white_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS archive_games_black_name_trgm
  ON archive_games USING gin (black_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS archive_games_event_trgm
  ON archive_games USING gin (event gin_trgm_ops);
