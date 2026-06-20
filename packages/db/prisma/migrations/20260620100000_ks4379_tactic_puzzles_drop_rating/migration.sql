-- KS-4379 / KS-4375. Удаление рейтинга пазла как сущности.
-- Пересмотр ADR-135 §2.1/§2.4 (коммит d12cf9e): подбор пазлов идёт
-- через mistakes-приоритет → random, Glicko-апдейт пользователя — против
-- фиксированного Maia-3 (OPPONENT_RATING=2400 в сервисе). Собственный
-- Glicko-рейтинг пазла и счётчики nbPlays/popularity больше не нужны.
--
-- T1 (KS-4376 shared), T2 (KS-4377 DTO), T3 (KS-4378 service) уже без
-- ссылок на эти колонки — DROP COLUMN на проде не сломает рантайм.
--
-- Откат:
--   ALTER TABLE tactic_puzzles
--     ADD COLUMN rating INT NOT NULL DEFAULT 1500,
--     ADD COLUMN rating_dev INT NOT NULL DEFAULT 350,
--     ADD COLUMN popularity INT NOT NULL DEFAULT 0,
--     ADD COLUMN nb_plays INT NOT NULL DEFAULT 0;
--   CREATE INDEX tactic_puzzles_rating_idx ON tactic_puzzles (rating);
--   ALTER TABLE tactic_puzzle_attempts
--     ADD COLUMN puzzle_rating_before INT,
--     ADD COLUMN puzzle_rating_after INT;
-- (история апдейтов рейтингов потеряна, бэкап не предусмотрен).

-- DropIndex
DROP INDEX IF EXISTS "tactic_puzzles_rating_idx";

-- AlterTable tactic_puzzles
ALTER TABLE "tactic_puzzles"
  DROP COLUMN "rating",
  DROP COLUMN "rating_dev",
  DROP COLUMN "popularity",
  DROP COLUMN "nb_plays";

-- AlterTable tactic_puzzle_attempts
ALTER TABLE "tactic_puzzle_attempts"
  DROP COLUMN "puzzle_rating_before",
  DROP COLUMN "puzzle_rating_after";
