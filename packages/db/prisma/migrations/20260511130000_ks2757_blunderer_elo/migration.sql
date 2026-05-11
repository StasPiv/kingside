-- KS-2757. ELO зевнувшего игрока для фильтра сложности на /precision.
-- Заполняется генератором tactic-worker при insert PVE-пазла.
ALTER TABLE "puzzles" ADD COLUMN "blunderer_elo" INTEGER;
CREATE INDEX "puzzles_blunderer_elo_idx" ON "puzzles" ("blunderer_elo");
