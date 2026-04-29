-- KS-2150: Event override применяется ко всем category, не только online-unknown.
--
-- Жалоба пользователя: фильтр «Классика» в архиве показывает партии
-- турниров «4th CHN Rapid/Blitz 2025», «World Blitz 2025», etc. Devops
-- по запросу coordinator снял срез:
--   classical=170 494 (12 863 partий event ILIKE '%rapid%',
--                       11 928 partий event ILIKE '%blitz%')
--   blitz=154 916 (0 ложных)
-- Корень: TWIC не пишет PGN-тег `[TimeControl]` для большинства рапид/
-- блиц турниров → fallback в classical через classifyGame
-- (`category='classical-legacy'` для OTB без тега). KS-2131/2133
-- Event-эвристика срабатывала ТОЛЬКО для online-unknown — TWIC мимо.
--
-- D-проверка от devops подтвердила безопасность generic-keywords:
--   event ILIKE '%blitz%' AND time_control SIMILAR TO '[5-9][0-9]+%' → 0 строк.
-- То есть нет классических турниров с подстрокой «blitz» в названии,
-- которые ошибочно перейдут в blitz после override.
--
-- ─── Маппинг (KS-2150) ──────────────────────────────────────────────
--
-- Event override (приоритет, если event соответствует hint):
--   event ILIKE bullet-хинт → 'bullet'
--   event ILIKE blitz-хинт  → 'blitz'
--   event ILIKE rapid-хинт  → 'rapid'
-- Если override не сработал — старая логика по category:
--   classical / classical-legacy → 'classical'
--   rapid → 'rapid', blitz → 'blitz', bullet → 'bullet'
--   correspondence / unknown / online-unknown → 'unknown'
--
-- Bullet раньше blitz раньше rapid — для Titled Tuesday Bullet Brawl
-- bullet (а не blitz по generic-keyword), для 4th CHN Rapid/Blitz blitz
-- (а не rapid по generic-keyword).
--
-- ─── Итоговый список Event-хинтов (KS-2150) ─────────────────────────
--
-- bullet:  'bullet brawl', 'hourly bullet', 'bullet arena', 'bullet'
-- blitz:   'titled tue', 'titled cup', 'blitz arena', 'arena titled',
--          'speed chess', 'speedchess', ' 3-0 thu', 'blitz'
-- rapid:   'rapidplay', 'rapid'   ← новые в KS-2150
--
-- Метрика успеха (devops подтвердит SQL'ом после деплоя):
--   classical 170 494 → ~145 703 (−24 791);
--   blitz 154 916 → ~166 800 (+11 928);
--   rapid 0 → ~12 863 (новая категория);
--   unknown без изменений.

UPDATE archive_games
   SET time_control_category = CASE
         -- KS-2150: Event override (приоритет ВСЕГДА, не только для online-unknown)
         WHEN event IS NOT NULL AND (
              event ILIKE '%bullet brawl%'
           OR event ILIKE '%hourly bullet%'
           OR event ILIKE '%bullet arena%'
           OR event ILIKE '%bullet%'
         ) THEN 'bullet'
         WHEN event IS NOT NULL AND (
              event ILIKE '%titled tue%'
           OR event ILIKE '%titled cup%'
           OR event ILIKE '%blitz arena%'
           OR event ILIKE '%arena titled%'
           OR event ILIKE '%speed chess%'
           OR event ILIKE '%speedchess%'
           OR event ILIKE '% 3-0 thu%'
           OR event ILIKE '%blitz%'
         ) THEN 'blitz'
         WHEN event IS NOT NULL AND (
              event ILIKE '%rapidplay%'
           OR event ILIKE '%rapid%'
         ) THEN 'rapid'
         -- Если Event override не сработал — старая логика по category
         WHEN category IN ('classical', 'classical-legacy') THEN 'classical'
         WHEN category = 'rapid' THEN 'rapid'
         WHEN category = 'blitz' THEN 'blitz'
         WHEN category = 'bullet' THEN 'bullet'
         ELSE 'unknown'
       END;
