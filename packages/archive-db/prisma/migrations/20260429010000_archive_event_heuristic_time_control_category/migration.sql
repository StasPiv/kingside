-- KS-2131: реклассификация archive_games.time_control_category с учётом
-- Event-эвристики для онлайн-партий без [TimeControl] тега.
--
-- Контекст. После KS-2118 фронт-фильтр «Контроль времени» (Архив партий)
-- разделяет партии по `time_control_category`. Backfill миграции
-- 20260429000000_archive_games_time_control_category мапил поле строго
-- из `category`, выведенного на этапе импорта `classifyGame`:
--   classical/classical-legacy → classical
--   rapid/blitz/bullet         → одноимённое
--   online-unknown             → 'unknown'   ← здесь корень жалобы
--   correspondence/unknown     → 'unknown'
--
-- Партии Titled Tuesday, Bullet Brawl, Speed Chess, Arena Titled и т.п.
-- импортёр на стадии `classifyGame` помечает как `online-unknown`
-- (Site=chess.com или Event-blacklist срабатывают), но без явного
-- `[TimeControl]` тега они уезжали в `time_control_category='unknown'`.
-- Пользователь жаловался: фильтр «Блиц» в архиве возвращает 0 партий —
-- хотя Titled Tuesday по факту блиц.
--
-- Решение: пересчитать `time_control_category` по тому же словарю
-- Event-хинтов, что использует runtime-классификатор
-- `apps/archive-service/src/archive-import/classify.ts::deriveArchiveTimeControlCategory`.
-- Bullet-хинты проверяются раньше blitz-хинтов — Titled Tuesday Bullet
-- Brawl должен дать bullet, а generic-keyword `blitz` сматчился бы
-- вторым.
--
-- ─── Маппинг (новый) ─────────────────────────────────────────────────
--
--   category='classical' OR category='classical-legacy'  → 'classical'
--   category='rapid'                                     → 'rapid'
--   category='blitz'                                     → 'blitz'
--   category='bullet'                                    → 'bullet'
--   category='online-unknown' AND event ILIKE bullet-хинт → 'bullet'
--   category='online-unknown' AND event ILIKE blitz-хинт  → 'blitz'
--   category='online-unknown' остальное                  → 'unknown'
--   category='correspondence' OR category='unknown'      → 'unknown'
--
-- Идемпотентно: миграция перезаписывает все строки одинаковым CASE,
-- повторный запуск даёт тот же результат. CONCURRENTLY не нужен —
-- это UPDATE, а не CREATE INDEX, и таблица archive_games (~323K строк)
-- проходит за единицы секунд.
--
-- ─── Список Event-хинтов (KS-2131) ───────────────────────────────────
--
-- bullet:  'bullet brawl', 'hourly bullet', 'bullet arena', 'bullet'
-- blitz:   'titled tuesday', 'titled cup', 'blitz arena',
--          'arena titled', 'speed chess', 'blitz'
--
-- Любое расширение списка ХИНТОВ требует новой миграции — runtime и
-- backfill ОБЯЗАНЫ совпадать, иначе свежеимпортированные партии и
-- старые получат разные категории при одинаковом Event.

UPDATE archive_games
   SET time_control_category = CASE
         WHEN category IN ('classical', 'classical-legacy') THEN 'classical'
         WHEN category = 'rapid' THEN 'rapid'
         WHEN category = 'blitz' THEN 'blitz'
         WHEN category = 'bullet' THEN 'bullet'
         WHEN category = 'online-unknown' AND event IS NOT NULL AND (
              event ILIKE '%bullet brawl%'
           OR event ILIKE '%hourly bullet%'
           OR event ILIKE '%bullet arena%'
           OR event ILIKE '%bullet%'
         ) THEN 'bullet'
         WHEN category = 'online-unknown' AND event IS NOT NULL AND (
              event ILIKE '%titled tuesday%'
           OR event ILIKE '%titled cup%'
           OR event ILIKE '%blitz arena%'
           OR event ILIKE '%arena titled%'
           OR event ILIKE '%speed chess%'
           OR event ILIKE '%blitz%'
         ) THEN 'blitz'
         ELSE 'unknown'
       END;
