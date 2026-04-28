-- KS-2063 / ADR-033 §4.2:
-- Expression-индекс для сортировки `archive_games` по `topElo` =
-- GREATEST(white_elo, black_elo) DESC NULLS LAST, id DESC.
--
-- Без этого индекса ORDER BY GREATEST(...) на больших корпусах
-- (TWIC: ~3M партий) делает sequential scan + sort и не вписывается в SLA
-- /api/archive/games (sub-second). Существующий индекс
-- `archive_games_played_at_idx` обслуживает sort=recent / oldest.

CREATE INDEX IF NOT EXISTS archive_games_top_elo_idx
  ON archive_games (GREATEST(white_elo, black_elo) DESC NULLS LAST, id DESC);
