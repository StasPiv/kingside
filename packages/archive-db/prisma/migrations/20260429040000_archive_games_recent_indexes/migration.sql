-- KS-2138 фаза 4: композитные индексы под холодные запросы /games.
--
-- Корень cold first-hit 5-7 сек на /games (по жалобе пользователя на
-- /archive: каждый клик 7 сек):
--   - `EXPLAIN ANALYZE /games?timeControlCategory=classical&sort=recent` →
--     Parallel Seq Scan по 330K строк / 760 МБ; Execution Time = 5689 ms.
--   - RDS db.t3.micro (shared_buffers 256 МБ) не вмещает таблицу;
--     каждый новый WHERE-shape выбивает кэш и читает 95K страниц с диска.
--   - Повтор того же URL — 60 мс (горячий кэш).
--
-- Существующие индексы archive_games:
--   - (eco, played_at DESC)
--   - (white_name, black_name)
--   - (played_at DESC) — без tie-break id, planner делает Parallel Seq Scan
--     при сочетании с фильтром.
--   - (time_control_category) — single column, planner для filter+sort
--     всё равно идёт Seq Scan.
--
-- Что добавляем:
--   1. `(time_control_category, played_at DESC NULLS LAST, id DESC)` —
--      композит под главный фильтр + ORDER BY (см.
--      MetadataSqlBuilder, sort='recent'). Tie-break по id чтобы keyset
--      pagination был стабильным.
--   2. `(played_at DESC NULLS LAST, id DESC)` — под sort='recent' без
--      фильтра. Старый `archive_games_played_at_idx` оставляем — drop
--      отдельно если pg_stat_user_indexes покажет idx_scan=0 после
--      перехода нагрузки на новый.
--   3. `archive_players (name_canonical)` — под JOIN-ключ
--      `pw.name_canonical = g.white_name` / `pb.name_canonical =
--      g.black_name` в `MetadataSqlBuilder.itemsSql`. Раньше JOIN шёл
--      Hash Join по большой таблице.
--
-- ─── Почему БЕЗ CONCURRENTLY ─────────────────────────────────────────
--
-- См. подробное обоснование в `20260429000000_archive_games_time_control_category`:
-- директива `-- prisma:disable_transaction` в Prisma 6 молча игнорируется,
-- миграция оборачивается в BEGIN/COMMIT, `CREATE INDEX CONCURRENTLY`
-- падает с `25001 — CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block`. На archive_games ~330K строк CREATE INDEX btree
-- занимает 1-3 сек с ACCESS EXCLUSIVE-локом — приемлемо для read-mostly
-- архив-таблицы (нагрузка importer ~раз в сутки cron).
--
-- ─── Acceptance ─────────────────────────────────────────────────────
--
-- - EXPLAIN ANALYZE /games?timeControlCategory=classical&sort=recent →
--   Index Scan (не Parallel Seq Scan), Execution Time < 100 мс.
-- - curl sequential 4 разных URL: каждый < 1 сек.
-- - Frontend /archive: каждый клик < 1 сек.

CREATE INDEX IF NOT EXISTS archive_games_tcc_played_at_id_idx
  ON archive_games (time_control_category, played_at DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS archive_games_played_at_id_idx
  ON archive_games (played_at DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS archive_players_name_canonical_idx
  ON archive_players (name_canonical);
