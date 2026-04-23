-- KS-1735 / ADR-023 §2.3: булевы флаги команды от Lichess.
--
-- `team_table`        — `tour.teamTable` от Lichess. Сигнал детектору
--                       `detectTournamentType` (apps/broadcast-service) для
--                       классификации командных турниров. Без флага fallback
--                       идёт по regex'у /team/i в `format`, что промахивается
--                       на форматах вроде "Match Bundesliga 2024".
-- `show_team_scores`  — `tour.showTeamScores` от Lichess. Влияет на рендер
--                       team-* турниров на фронте (показывать ли колонки
--                       team-score) — A14/A15.
--
-- Default false для обратной совместимости с существующими записями.
-- Backfill придёт естественно при следующем sync-цикле (BroadcastSyncService
-- читает `tour.teamTable`/`tour.showTeamScores` и пишет в upsert).

-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN "team_table" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "broadcasts" ADD COLUMN "show_team_scores" BOOLEAN NOT NULL DEFAULT false;
