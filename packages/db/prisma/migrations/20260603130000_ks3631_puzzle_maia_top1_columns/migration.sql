-- KS-3631 / ADR-104 §4. Колонки для offline-разметки Maia-3 на
-- precision-пазлах + composite-индекс под основной precision-запрос.
--
-- Семантика:
--   - `maia_top1_prob` — вероятность правильного хода (первого UCI
--     в `moves`) по Maia-3. Заполняется admin-CLI
--     `tools/maia-puzzle-annotation/` либо tactic-worker'ом при создании
--     нового пазла. NULL — ещё не размечен (safe fallback: фронт
--     включает такие пазлы в выдачу).
--   - `maia_top1_elo` — ELO разметки. Используется для проверки
--     актуальности при смене ENV `PRECISION_MAIA_ANNOTATION_ELO`.
--
-- Размер на 6M строк: REAL 4 B × 6M = 24 МБ + INT 4 B × 6M = 24 МБ +
-- composite-индекс. Принимаемо.
--
-- Composite-индекс `(solution_mode, maia_top1_prob)` покрывает основной
-- precision-запрос:
--   `WHERE solution_mode = 'play-vs-engine'
--      AND (maia_top1_prob IS NULL OR maia_top1_prob <= $threshold)`.
-- Postgres использует индекс и для NULL-вариантов (b-tree поддерживает
-- NULLS LAST по умолчанию).
--
-- ALTER без значения — Postgres делает быстрый DDL (метаданные, без
-- переписывания страниц). На существующих 6M пазлах обе колонки = NULL.

ALTER TABLE "puzzles"
  ADD COLUMN "maia_top1_prob" REAL,
  ADD COLUMN "maia_top1_elo" INT4;

CREATE INDEX "puzzles_solution_mode_maia_top1_prob_idx"
  ON "puzzles" ("solution_mode", "maia_top1_prob");
