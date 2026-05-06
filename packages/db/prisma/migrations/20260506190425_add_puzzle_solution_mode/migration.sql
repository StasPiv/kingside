-- KS-2463 / ADR-044 §3.2.
-- Поле `solution_mode` для модели `Puzzle`:
--   - 'forced-line' — классическая фиксированная линия (Lichess + KS-2431
--     generated). Все существующие записи получают это значение через
--     DEFAULT, backfill не требуется.
--   - 'play-vs-engine' — новый режим: решатель играет против движка,
--     удерживая WDL ≥ порога (KS-2461 эпик).
--
-- Существующий partial UNIQUE `puzzle_generated_fen_uniq` (KS-2431,
-- миграция 20260505140000) НЕ трогаем — он остаётся работать на
-- `source = 'generated'` независимо от `solution_mode`.

ALTER TABLE "puzzles"
  ADD COLUMN "solution_mode" TEXT NOT NULL DEFAULT 'forced-line';

CREATE INDEX "puzzles_solution_mode_idx" ON "puzzles" ("solution_mode");
