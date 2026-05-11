-- KS-2759. Откат KS-2757: blunderer_elo заменён на JOIN с archive_games
-- через postgres_fdw (archive_games_remote). Колонка и индекс не нужны.
DROP INDEX IF EXISTS "puzzles_blunderer_elo_idx";
ALTER TABLE "puzzles" DROP COLUMN IF EXISTS "blunderer_elo";
