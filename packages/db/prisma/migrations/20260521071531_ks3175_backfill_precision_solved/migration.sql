-- KS-3175. Backfill legacy `puzzle_attempts.solved=false` для записей
-- с парной `precision_attempts.score = 5`.
--
-- Контекст: KS-3169 исправил `meetsFinalObjective` для saveEquality
-- (удержание ничьи теперь засчитывается как solved=true), но фикс
-- работает только для НОВЫХ попыток. Legacy-записи с 5★ остались
-- с solved=false; фронт лечит UI через derived (KS-3173), а здесь
-- приводим БД к консистентному виду для статистики/фильтров.
--
-- `solved` лежит на `puzzle_attempts`; `score` — на `precision_attempts`.
-- Связь 1:1: precision_attempts.attempt_id = puzzle_attempts.id.
--
-- Идемпотентно: WHERE solved=false ограничивает выборку только теми
-- записями, которые ещё не пометили. Условие score=5 — единственный
-- стабильный признак «5★» (см. precision-score.ts mapToStars).

UPDATE "puzzle_attempts" pa
   SET "solved" = true
  FROM "precision_attempts" pr
 WHERE pr."attempt_id" = pa."id"
   AND pr."score" = 5
   AND pa."solved" = false;

-- Acceptance:
--   SELECT COUNT(*)
--     FROM puzzle_attempts pa
--     JOIN precision_attempts pr ON pr.attempt_id = pa.id
--    WHERE pa.solved = false AND pr.score = 5;
-- ↑ должно вернуть 0 после миграции.
