-- KS-2760: проверка pushdown. Запускается из main БД `kingside`.
\set ON_ERROR_STOP on
\echo === EXPLAIN ANALYZE pushdown (white_elo >= 2400) ===
EXPLAIN (ANALYZE, VERBOSE) SELECT id, white_elo, black_elo
  FROM archive_games_remote
  WHERE white_elo >= 2400
  LIMIT 10;
