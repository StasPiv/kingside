-- KS-2120: DROP неиспользуемых индексов archive-db (~307 МБ освобождения).
--
-- Контекст. db.t3.micro (1 ГБ RAM, shared_buffers ~189 МБ) с архивом 2.75 ГБ.
-- Индексы вдвое больше данных и не помещаются в shared_buffers — горячие
-- запросы сваливаются на диск и получают latency > 1s. Апгрейда инстанса
-- не будет, лечим со стороны схемы.
--
-- pg_stat_user_indexes (idx_scan=0 за окно метрик ~24ч — индекс не
-- использован НИ ОДНИМ запросом):
--   - archive_game_positions_recent           — 298 МБ
--   - archive_players_aliases_trgm            —   5 МБ
--   - archive_games_source_id_played_at_idx   —   2 МБ
--   - archive_players_name_normalized_idx     —   1 МБ
--
-- Также снижается нагрузка на autovacuum (меньше пустых страниц для
-- vacuum'а) и WAL (меньше index-write traffic). После DROP'а
-- соответствующие pg_class страницы освободятся при ближайшем `VACUUM`
-- (или сразу через `VACUUM FULL`, но FULL блокирует таблицу — devops
-- отдельно по необходимости).
--
-- ─── Стратегия применения ───────────────────────────────────────────
--
-- Решение по KS-2120: используем обычный `DROP INDEX IF EXISTS` БЕЗ
-- CONCURRENTLY (вариант 3 от координатора). Лок таблицы на DROP — секунды
-- (Postgres удаляет btree/GIN моментально, основная стоимость — ACCESS
-- EXCLUSIVE захват, который дожидается завершения активных запросов).
-- На archive-таблицах с read-mostly паттерном это терпимо. Стандартная
-- Prisma миграция, без `migrate resolve`.
--
-- IF EXISTS — идемпотентность: если миграция уже частично применилась
-- руками, повторный apply пройдёт без ошибки.
--
-- Schema-side: соответствующие `@@index` сняты из `prisma/schema.prisma`
-- в этом же коммите — иначе следующий `prisma migrate dev` сгенерировал
-- бы CREATE и вернул индексы обратно. `archive_players_aliases_trgm` в
-- schema.prisma никогда не объявлялся (GIN trgm создаются raw-SQL
-- миграцией `20260428000001_archive_players_events_mv`).
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────
--
-- Если окно метрик 24ч оказалось нерепрезентативным (например, какой-то
-- редкий аналитический запрос выпал из выборки), индексы можно вернуть
-- следующими SQL-командами (точные определения сняты из исходных
-- миграций `20260421000000_init` и `20260428000001_archive_players
-- _events_mv`):
--
--   CREATE INDEX archive_game_positions_recent
--     ON archive_game_positions
--        (position_key, bucket, played_at DESC, game_id DESC);
--
--   CREATE INDEX archive_players_aliases_trgm
--     ON archive_players USING GIN (name_aliases gin_trgm_ops);
--
--   CREATE INDEX archive_games_source_id_played_at_idx
--     ON archive_games (source_id, played_at DESC);
--
--   CREATE INDEX archive_players_name_normalized_idx
--     ON archive_players (name_normalized);
--
-- На проде ROLLBACK гонять CONCURRENTLY: `CREATE INDEX CONCURRENTLY ...`
-- иначе будет блокировка таблицы на минуты-десятки (билд индекса по
-- большой таблице).

DROP INDEX IF EXISTS public.archive_game_positions_recent;

DROP INDEX IF EXISTS public.archive_players_aliases_trgm;

DROP INDEX IF EXISTS public.archive_games_source_id_played_at_idx;

DROP INDEX IF EXISTS public.archive_players_name_normalized_idx;
