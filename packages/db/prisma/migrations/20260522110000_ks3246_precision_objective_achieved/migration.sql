-- KS-3246. Колонка `precision_attempts.objective_achieved` — достигнута
-- ли цель пазла (по objective из source_metadata).
--
-- Контекст: до этой задачи фронт строил плашку только по `score`
-- (5★/4★/3★/...). При single inaccuracy и положительной ΔE игрок
-- получал плашку «Решено с заметными ошибками» — терминологически
-- неверно (chess-expert: `?!` это inaccuracy, не «ошибка»), и логически
-- противоречиво (вероятность победы выросла).
--
-- Правильная архитектура — две оси: (star_rank, goal_achieved).
-- Плашка считается фронтом по матрице 5×2 из chess-expert review
-- (KS-3248). Здесь — добавляем backend-источник истины для goal.
--
-- Правила goal_achieved (E = (W + D/2) / 1000, POV игрока):
--   - convertAdvantage: end_E ≥ start_E − 0.02 (зона округления)
--   - saveEquality:     end_E ≥ start_E − 0.05
--
-- Колонка NULL-able: legacy-attempt'ы без per-move WDL остаются NULL
-- (фронт fallback'ом на старую логику по score; не critical).
--
-- Backfill: WITH-cte берёт первый/последний move с WDL у каждого
-- attempt'а, считает E, сравнивает с порогом по objective пазла.
-- Идемпотентно — WHERE objective_achieved IS NULL.

ALTER TABLE "precision_attempts"
  ADD COLUMN IF NOT EXISTS "objective_achieved" BOOLEAN NULL;

CREATE INDEX IF NOT EXISTS "precision_attempts_objective_achieved_idx"
  ON "precision_attempts" ("objective_achieved");

-- Backfill для legacy-attempt'ов с per-move WDL.
WITH attempt_e AS (
  SELECT
    pa.attempt_id,
    (p.source_metadata::jsonb ->> 'objective') AS objective,
    (
      SELECT (m.wdl_before_w + m.wdl_before_d::float / 2) / 1000.0
        FROM precision_attempt_moves m
       WHERE m.attempt_id = pa.attempt_id
         AND m.wdl_before_w IS NOT NULL
         AND m.wdl_before_d IS NOT NULL
       ORDER BY m.ply ASC
       LIMIT 1
    ) AS start_e,
    (
      SELECT (m.wdl_after_w + m.wdl_after_d::float / 2) / 1000.0
        FROM precision_attempt_moves m
       WHERE m.attempt_id = pa.attempt_id
         AND m.wdl_after_w IS NOT NULL
         AND m.wdl_after_d IS NOT NULL
       ORDER BY m.ply DESC
       LIMIT 1
    ) AS end_e
    FROM precision_attempts pa
    JOIN puzzle_attempts att ON att.id = pa.attempt_id
    JOIN puzzles p           ON p.id = att.puzzle_id
   WHERE pa.objective_achieved IS NULL
)
UPDATE precision_attempts pa
   SET objective_achieved = CASE
     WHEN ae.objective = 'convertAdvantage' THEN ae.end_e >= ae.start_e - 0.02
     WHEN ae.objective = 'saveEquality'     THEN ae.end_e >= ae.start_e - 0.05
     ELSE NULL
   END
  FROM attempt_e ae
 WHERE pa.attempt_id = ae.attempt_id
   AND ae.objective IN ('convertAdvantage', 'saveEquality')
   AND ae.start_e IS NOT NULL
   AND ae.end_e IS NOT NULL;

-- Acceptance:
--   SELECT COUNT(*) FROM precision_attempts WHERE objective_achieved IS NULL;
-- ↑ должно быть много меньше total после backfill — остаются только
-- legacy без per-move WDL (KS-2717 и старше).
