-- KS-2998 / ADR-065 §6.1. 5-балльная оценка решения precision-задачи.
--
-- Добавляет в `precision_attempts`:
--  - `score INT NULL` — 1..5 stars (mapToStars из @kingside/shared).
--  - `score_pct DOUBLE PRECISION NULL` — scorePct (0..100) до округления.
--  - INDEX по `score` для агрегатов «средний балл / распределение»
--    в Уровне А (карточка «Средний балл», ADR-065 §5.1.3) и для
--    trend-графиков.
--
-- Безопасна: 2 nullable-колонки без default; не блокирует runtime,
-- ALTER TABLE ADD COLUMN NULL в Postgres — мгновенный.

ALTER TABLE "precision_attempts"
  ADD COLUMN "score" INTEGER,
  ADD COLUMN "score_pct" DOUBLE PRECISION;

CREATE INDEX "precision_attempts_score_idx"
  ON "precision_attempts" ("score");
