-- KS-2133: расширение Event-эвристики двумя подстроками.
--
-- Контекст. После KS-2131-fix (миграция
-- `20260429020000_archive_event_heuristic_titled_tue`) остаточные 46 106
-- партий в `time_control_category='unknown'`. Devops по запросу
-- coordinator снял топ хвоста и распределение `time_control` по подозрительным
-- event'ам. Главные находки:
--
-- 1) `1st/2nd/3rd 3-0 Thu …` (включая редкое `Thursday` вместо `Thu`) —
--    41 020 партий, у всех `time_control = NULL`. Это chess.com weekly-серия
--    3+0 (3 минуты + 0 инкремент) → блиц.
-- 2) `chess.com SpeedChess 2025` — 287 партий, все `time_control = NULL`.
--    Существующий хинт `'speed chess'` (с пробелом) не матчил slitno.
--
-- Решение. Добавить в `EVENT_BLITZ_HINTS` две подстроки:
--   - `' 3-0 thu'` (с ведущим пробелом — отсекает счёт партии в начале строки)
--   - `'speedchess'` (slitno)
--
-- runtime-классификатор `deriveArchiveTimeControlCategory` и эта SQL-миграция
-- используют один словарь (см. `packages/shared/src/utils/time-control.ts`).
--
-- Идемпотентно: миграция перезаписывает все строки одинаковым CASE,
-- повторный запуск даёт тот же результат. Без CONCURRENTLY (UPDATE),
-- 323K строк проходят за единицы секунд.
--
-- ─── Маппинг (тот же, что в 20260429020000, плюс две подстроки) ──────
--
--   category='classical' OR 'classical-legacy' → 'classical'
--   category='rapid'/'blitz'/'bullet'          → одноимённое
--   category='online-unknown' AND event ILIKE bullet-хинт → 'bullet'
--   category='online-unknown' AND event ILIKE blitz-хинт  → 'blitz'
--   category='online-unknown' остальное                  → 'unknown'
--   category='correspondence' OR 'unknown'               → 'unknown'
--
-- ─── Итоговый список Event-хинтов (KS-2133) ──────────────────────────
--
-- bullet:  'bullet brawl', 'hourly bullet', 'bullet arena', 'bullet'
-- blitz:   'titled tue',   'titled cup',    'blitz arena',
--          'arena titled', 'speed chess',   'speedchess',
--          ' 3-0 thu',     'blitz'
--
-- Метрика успеха (devops подтвердит SQL'ом после деплоя):
--   blitz >= 154 916 (113 609 + 41 020 + 287);
--   unknown <= 4 799 (46 106 - 41 307).
--
-- Не вошли в эту миграцию (нужны явные данные TC, угадывать не стали):
--   - Abu Dhabi Masters Online (1 323) — TC=NULL, по названию неясно;
--   - TCEC Premier/Superfinal (~648) — engine-классика, не блиц;
--   - Online Winter Cup (680), Chess.com Open PlayIn (1 303), WSCC (244),
--     Comet (243) — без явного TC-подтверждения оставлены unknown.

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
              event ILIKE '%titled tue%'
           OR event ILIKE '%titled cup%'
           OR event ILIKE '%blitz arena%'
           OR event ILIKE '%arena titled%'
           OR event ILIKE '%speed chess%'
           OR event ILIKE '%speedchess%'
           OR event ILIKE '% 3-0 thu%'
           OR event ILIKE '%blitz%'
         ) THEN 'blitz'
         ELSE 'unknown'
       END;
