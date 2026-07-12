-- KS-4922. Data-fix: занятия, собранные ДО KS-4918 с "темой" из
-- служебных токенов генератора задач (playVsEngine/reactive/preventive —
-- это режим решения и фаза пазла, а не темы). У таких уроков puzzle-шаг
-- искал задачи по несуществующей теме в rating-окне и был пуст
-- («Для этого шага нет задач»), прогресс блокировался.
-- По прод-выборке затронут 1 урок (ed100a6d, title «Занятие: reactive»).
--
-- 1) puzzle-шаги с служебным токеном в selection.themes → themes:[]
--    (пустой массив = смешанные задачи по rating-окну; валиден после
--    KS-4919, резолвер пустую тему игнорирует).
UPDATE lesson_steps
SET payload = jsonb_set(payload, '{selection,themes}', '[]'::jsonb)
WHERE type = 'puzzle'
  AND payload -> 'selection' -> 'themes' ?| ARRAY['reactive', 'preventive', 'playVsEngine'];

-- 2) Названия пользовательских уроков с сырым служебным ключом →
--    нейтральное «Тактика» (тема из шага убрана, занятие смешанное).
UPDATE lessons
SET title = regexp_replace(title, 'reactive|preventive|playVsEngine', 'Тактика', 'g')
WHERE owner_id IS NOT NULL
  AND title ~ '(reactive|preventive|playVsEngine)';
