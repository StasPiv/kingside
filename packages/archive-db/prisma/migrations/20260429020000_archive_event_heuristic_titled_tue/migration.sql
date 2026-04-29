-- KS-2131-fix: расширение словаря Event-эвристики до сокращённой формы
-- TWIC `Titled Tue …` (а не `Titled Tuesday`).
--
-- Контекст. Первая backfill-миграция KS-2131
-- (`20260429010000_archive_event_heuristic_time_control_category`)
-- использовала подстроку `titled tuesday`. На проде devops подтвердил,
-- что эвристика **не нашла ни одной строки**: TWIC хранит сокращённую
-- форму `Titled Tue 17th Jun Early`, `Titled Tue 23rd Sep 2025` и т.п.
-- Контрольный COUNT — 113 609 партий с подстрокой `titled tue` сидят в
-- `time_control_category='unknown'`. Топ-30 unknown событий — все
-- `Titled Tue ...`.
--
-- Решение. Расширяем словарь хинтов до подстроки `titled tue` (она
-- покрывает и сокращённую `Titled Tue`, и полную `Titled Tuesday`,
-- потому что `'titled tuesday'.includes('titled tue') === true`).
-- runtime-классификатор (`ARCHIVE_TIME_CONTROL_EVENT_HINTS` в
-- `packages/shared`) и эта миграция используют один словарь.
--
-- Идемпотентно: миграция перезаписывает все строки одинаковым CASE,
-- повторный запуск даёт тот же результат. Без CONCURRENTLY (это
-- UPDATE), 323K строк проходят за единицы секунд.
--
-- ─── Маппинг (тот же, что в 20260429010000, плюс `titled tue`) ───────
--
--   category='classical' OR category='classical-legacy' → 'classical'
--   category='rapid'                                    → 'rapid'
--   category='blitz'                                    → 'blitz'
--   category='bullet'                                   → 'bullet'
--   category='online-unknown' AND event ILIKE bullet-хинт → 'bullet'
--   category='online-unknown' AND event ILIKE blitz-хинт  → 'blitz'
--   category='online-unknown' остальное                 → 'unknown'
--   category='correspondence' OR category='unknown'     → 'unknown'
--
-- ─── Итоговый список Event-хинтов (KS-2131-fix) ──────────────────────
--
-- bullet:  'bullet brawl', 'hourly bullet', 'bullet arena', 'bullet'
-- blitz:   'titled tue',   'titled cup',    'blitz arena',
--          'arena titled', 'speed chess',   'blitz'
--
-- Метрика успеха (devops подтвердит SQL'ом после деплоя): после
-- backfill `blitz >= 113 609`, `unknown <= 46 106` (159 715 - 113 609).

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
           OR event ILIKE '%blitz%'
         ) THEN 'blitz'
         ELSE 'unknown'
       END;
