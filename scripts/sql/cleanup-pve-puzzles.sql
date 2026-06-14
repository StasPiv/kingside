-- KS-2754: очистка PVE-пазлов на локальной БД kingside перед регенерацией
-- через tactic-worker. У старых пазлов в sourceMetadata нет поля
-- `fenBeforeBlunder` (добавлено коммитом 96eb4acd), фронту /precision без
-- него нечего показывать.
--
-- DELETE на puzzles каскадом утянет связанные:
--   puzzle_attempts (FK puzzle_id) →
--     precision_attempts (FK attempt_id, ON DELETE CASCADE) →
--       precision_attempt_moves (FK attempt_id, ON DELETE CASCADE).
-- Другие таблицы (puzzle_rush_*, user_mistakes, рейтинги Glicko) на
-- puzzle_attempts напрямую не ссылаются и не трогаются.

DELETE FROM puzzles WHERE solution_mode = 'play-vs-engine';
