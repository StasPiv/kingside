-- KS-2118: фильтр архива партий по категории контроля времени.
--
-- Что делаем:
--   1. ADD COLUMN `time_control_category` (TEXT) — `bullet|blitz|rapid|classical|unknown`.
--      Колонка `time_control` (сырой PGN-тег) уже была добавлена ранее
--      (миграция `20260421000000_init`).
--   2. CHECK-ограничение на допустимые значения (5 категорий + NULL во
--      время backfill / для новых строк, которые ещё не классифицировал
--      парсер).
--   3. Backfill значениями, выведенными из существующего `category`
--      (классификатор archive-import уже отработал в миграции
--      KS-1626 / classify-existing CLI). Маппинг — см. ниже.
--   4. Обычный B-tree индекс по `time_control_category` —
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
-- ─── Почему БЕЗ CONCURRENTLY (фикс KS-2118 / KS-2121) ────────────────
--
-- Первая редакция миграции содержала `CREATE INDEX CONCURRENTLY` под
-- директивой `-- prisma:disable_transaction`. Такой директивы в Prisma 6
-- нет (проверено в `node_modules/prisma/build/index.js` и schema-engine
-- бинаре) — комментарий молча игнорируется, миграция оборачивается в
-- транзакцию, CREATE INDEX CONCURRENTLY падает с
-- `Database error code: 25001 — CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block`. `applied_steps_count=0` — ни один шаг не
-- закоммитился. KS-2120 (drop_unused_archive_indexes) встаёт за этой
-- failed-записью с P3009.
--
-- Решение: убираем CONCURRENTLY. На archive_games ~323K строк (актуальный
-- COUNT, исходное «>5M» в комментарии было ошибочной экстраполяцией с
-- archive_game_positions); CREATE INDEX по btree TEXT занимает 1-3 сек с
-- ACCESS EXCLUSIVE-локом — приемлемо для read-mostly архив-таблицы.
-- Миграция целиком становится транзакционной (Prisma по умолчанию
-- оборачивает в BEGIN/COMMIT) — ADD COLUMN + CHECK + UPDATE 323K строк +
-- CREATE INDEX за один atomic step, при сбое автоматический откат.

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

CREATE INDEX IF NOT EXISTS archive_games_time_control_category_idx
  ON archive_games (time_control_category);
