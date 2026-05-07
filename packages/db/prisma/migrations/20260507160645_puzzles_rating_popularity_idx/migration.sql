-- KS-2562. `/puzzles/next` падал на проде ~10.9с после импорта 6M
-- lichess. Корневой запрос:
--   SELECT * FROM puzzles
--    WHERE rating BETWEEN $1 AND $2
--      AND NOT EXISTS (...)  -- anti-join puzzle_attempts
--    ORDER BY popularity DESC
--    LIMIT 10;
-- Существующий индекс (rating) → range scan на rating диапазоне (для
-- ±200 от среднего user-rating это сотни тысяч / миллион строк),
-- затем sort by popularity → 10+ секунд.
--
-- Composite (rating, popularity DESC) даёт BTREE с уже отсортированной
-- popularity внутри каждого rating-bucket. Index Scan ходит по rating
-- range и для каждого rating сразу выдаёт top-popularity → planner
-- стопает рано на LIMIT 10.
--
-- IF NOT EXISTS — для совместимости с CONCURRENTLY от devops.

CREATE INDEX IF NOT EXISTS "puzzles_rating_popularity_idx"
  ON "puzzles" ("rating", "popularity" DESC);
