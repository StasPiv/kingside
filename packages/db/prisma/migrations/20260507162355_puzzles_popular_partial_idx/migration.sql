-- KS-2562 фаза 2. После применения предыдущей миграции
-- (20260507160645) devops подтвердил: composite (rating, popularity
-- DESC) на 6M строк (~250 МБ) НЕ помещается в shared_buffers
-- t3.micro (256 МБ). Postgres planner на широком rating-range (±200,
-- ~470k = 8% строк) выбирает Parallel Seq Scan: heap_fetch стоит
-- дороже sequential read, всё с диска. Cold-cache 36 сек даже на
-- узком range (±50, ~70k).
--
-- Решение: PARTIAL index `WHERE popularity >= 50`. Lichess популярность
-- от -100..+100 (community-рейтинг пазла), >=50 ≈ топ-10% качественных.
-- Индекс уменьшается до ~25 МБ — влезает в shared_buffers, hot-cache.
--
-- Trade-off: generated пазлы с дефолтным popularity=0 не попадают в
-- partial. Но на проде сейчас generated puzzle'ы единичные; пользователь
-- видит lichess-пазлы (~6M). Если в будущем будут много generated с
-- popularity=0 — fallback path в `getNextPuzzle` (без popularity-filter)
-- их вернёт.
--
-- Drop старого composite — не оставляем мусорный 250 МБ индекс на t3.micro.

DROP INDEX IF EXISTS "puzzles_rating_popularity_idx";

CREATE INDEX IF NOT EXISTS "puzzles_rating_popularity_partial_idx"
  ON "puzzles" ("rating", "popularity" DESC)
  WHERE "popularity" >= 50;
