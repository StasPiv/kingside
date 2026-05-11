-- KS-2760: индексы (white_elo), (black_elo) на archive_games в локальной БД kingside_archive.
-- CONCURRENTLY не нужен — локальная БД, можно с эксклюзивной блокировкой
-- (она пустая или маленькая, importer переподключится при необходимости).
--
-- Параллельно с этим, на prod archive RDS такие же индексы созданы CONCURRENTLY.

\set ON_ERROR_STOP on

\echo === archive DB (kingside_archive): indexes for FDW pushdown ===

CREATE INDEX IF NOT EXISTS archive_games_white_elo_idx ON public.archive_games (white_elo);
CREATE INDEX IF NOT EXISTS archive_games_black_elo_idx ON public.archive_games (black_elo);

\echo === sanity archive indexes ===
SELECT indexname FROM pg_indexes
WHERE schemaname='public' AND tablename='archive_games'
  AND indexname IN ('archive_games_white_elo_idx','archive_games_black_elo_idx')
ORDER BY indexname;
