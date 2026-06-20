-- KS-4370 / KS-4367. Удаление поля `objective` из tactic_puzzles.
-- Семантика «реализуй перевес / удержи равенство» оказалась ad-hoc
-- эвристикой, не отражённой в UI (пересмотр ADR-135 §2.3, коммит
-- f8fa746). T2 (shared) и T3 (apps/api) уже без ссылок на колонку —
-- DROP COLUMN на проде не сломает рантайм.
--
-- Сначала индекс (требование PostgreSQL), затем колонка.
--
-- Откат: ADD COLUMN objective TEXT + UPDATE по WDL
--   `wdl_w/1000 >= 0.5 ? 'convertAdvantage' : 'saveEquality'`
-- (см. описание задачи).

-- DropIndex
DROP INDEX IF EXISTS "tactic_puzzles_objective_rating_idx";

-- AlterTable
ALTER TABLE "tactic_puzzles" DROP COLUMN "objective";
