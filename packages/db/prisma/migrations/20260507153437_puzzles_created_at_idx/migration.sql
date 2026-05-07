-- KS-2557. После импорта 6M lichess-пазлов (KS-2556) запрос
-- `/puzzles/browse?sort=createdAt&order=desc` падал по таймауту:
-- ORDER BY p.created_at DESC по 6M строкам без индекса = full
-- table scan + sort. Добавляем индекс на `created_at` (DESC через
-- Backward Index Scan), чтобы Postgres мог взять top-N через
-- index-scan и stop early на LIMIT N.
--
-- IF NOT EXISTS — на случай когда devops применит CREATE INDEX
-- CONCURRENTLY на prod руками (вне миграции, чтобы не блокировать
-- writes), и затем следующий `prisma migrate deploy` через CI
-- не упадёт на дубликате.
--
-- Простой single-column индекс выбран намеренно:
--  - Composite `(is_public, created_at DESC)` мог бы быть быстрее для
--    anon-кейса, но 99% lichess-пазлов имеют is_public=true →
--    Postgres всё равно почти не отфильтрует строк.
--  - Backward Index Scan через ASC-индекс работает для DESC ORDER BY.
--    Postgres planner сам решит scan-направление.
--  - Visibility OR-condition `(created_by = X OR is_public = true)`
--    + index scan по created_at: planner делает index scan, фильтрует
--    каждую строку — для 99% is_public=true строк фильтр практически
--    бесплатный, top-20 находятся за единицы миллисекунд.

CREATE INDEX IF NOT EXISTS "puzzles_created_at_idx"
  ON "puzzles" ("created_at");
