-- prisma:disable_transaction
-- KS-2118: фильтр архива партий по категории контроля времени.
--
-- Что делаем:
--   1. ADD COLUMN `time_control_category` (TEXT) — `bullet|blitz|rapid|classical|unknown`.
--      Колонка `time_control` (сырой PGN-тег) уже была добавлена ранее
--      (миграция `20260421000000_init`).
--   2. CHECK-ограничение на допустимые значения (5 категорий + NULL во
--      время backfill).
--   3. Backfill значениями, выведенными из существующего `category`
--      (классификатор archive-import уже отработал в миграции
--      KS-1626 / classify-existing CLI). Маппинг — см. ниже.
--   4. B-tree индекс CONCURRENTLY по `time_control_category` —
--      фильтр будет частым на эндпоинтах `/games` и
--      `/players/:slug/games`.
--
-- Маппинг существующего `category` → `time_control_category`:
--   classical, classical-legacy            → 'classical'
--   rapid                                  → 'rapid'
--   blitz                                  → 'blitz'
--   bullet                                 → 'bullet'
--   correspondence, online-unknown, unknown → 'unknown'
--
-- Это расходится с парсингом «по PGN-строке» только в нескольких краях:
--   - партии без [TimeControl] на онлайн-сайтах ловятся как
--     `online-unknown` → `unknown` (а не пытаемся угадывать);
--   - `classical-legacy` (OTB до ~2005, тег отсутствовал) — `classical`,
--     потому что фронт-фильтр интересует «найти классические партии»,
--     а не «строго PGN-пометка».
--
-- Для новых партий поле заполняется парсером (`classifyPgnTimeControl`
-- из @kingside/shared), для существующих — этим backfill.
--
-- CONCURRENTLY: archive_games — большая таблица (>5M строк), ACCESS
-- EXCLUSIVE-блокировка недопустима в prod. Prisma migrate deploy
-- выполняет statement'ы вне транзакции (auto-commit) — это совместимо
-- с CONCURRENTLY. IF NOT EXISTS — для идемпотентного re-apply.

ALTER TABLE archive_games
  ADD COLUMN IF NOT EXISTS time_control_category TEXT NULL;

ALTER TABLE archive_games
  DROP CONSTRAINT IF EXISTS archive_games_time_control_category_check;

ALTER TABLE archive_games
  ADD CONSTRAINT archive_games_time_control_category_check
    CHECK (
      time_control_category IS NULL
      OR time_control_category IN ('bullet', 'blitz', 'rapid', 'classical', 'unknown')
    );

-- Backfill: для всех существующих партий выводим категорию из
-- `category`. Партии с category='unknown' (не классифицировались ранее
-- из-за parser-ошибки) тоже получают 'unknown'.
UPDATE archive_games
   SET time_control_category = CASE
         WHEN category IN ('classical', 'classical-legacy') THEN 'classical'
         WHEN category = 'rapid' THEN 'rapid'
         WHEN category = 'blitz' THEN 'blitz'
         WHEN category = 'bullet' THEN 'bullet'
         ELSE 'unknown'
       END
 WHERE time_control_category IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS archive_games_time_control_category_idx
  ON archive_games (time_control_category);
