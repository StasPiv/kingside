-- KS-2762. Денормализация ELO игроков партии-источника в puzzles.
-- Используется фильтром /puzzles/browse `?blundererEloMin/Max` через
-- CASE по side-to-move из source_metadata.fenBeforeBlunder. FDW JOIN
-- на archive_games_remote больше не нужен (KS-2761/perf-fix).
ALTER TABLE "puzzles"
  ADD COLUMN "source_white_elo" INTEGER,
  ADD COLUMN "source_black_elo" INTEGER;
CREATE INDEX "puzzles_source_white_elo_idx" ON "puzzles" ("source_white_elo");
CREATE INDEX "puzzles_source_black_elo_idx" ON "puzzles" ("source_black_elo");
