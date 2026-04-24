-- KS-1813: детект типа турнира для broadcast-раунда + поля для сетки плей-офф.
--
-- `broadcast_rounds.tournament_type` — `round_robin | swiss | playoff | unknown`.
--   Определяется при upsert'е раунда (apps/broadcast-service/src/crosstable/
--   detect-round-tournament-type.ts) по названию раунда + `Broadcast.format` +
--   структуре пар. Для старых записей остаётся null — фронт воспринимает null
--   и `'unknown'` одинаково (legacy-рендер).
--
-- `broadcast_games.bracket_stage`  — этап плей-офф: 'quarter' | 'semi' | 'final'
--                                     | 'grand_final' | 'round_of_16' | 'winners_<stage>'
--                                     | 'losers_<stage>' | 'playoff' (fallback).
-- `broadcast_games.bracket_pair_id` — стабильный id пары внутри раунда,
--                                     формат '<stage>:<playerA>|<playerB>'
--                                     (имена лексикографически отсортированы).
--                                     Пары одинаковы у партий одного матча.
-- `broadcast_games.match_score`     — текущий счёт пары по партиям, строка
--                                     вида '2-1' или '2½-1½'. Пересчитывается
--                                     после каждого PGN-обновления.
--
-- Все поля nullable: для round-robin / swiss остаются null, старые записи
-- до первого sync-цикла тоже остаются null — клиент не падает.

-- AlterTable
ALTER TABLE "broadcast_rounds" ADD COLUMN "tournament_type" TEXT;

ALTER TABLE "broadcast_games" ADD COLUMN "bracket_stage" TEXT;
ALTER TABLE "broadcast_games" ADD COLUMN "bracket_pair_id" TEXT;
ALTER TABLE "broadcast_games" ADD COLUMN "match_score" TEXT;

-- Индекс по (round_id, bracket_pair_id) — для группировки партий одного
-- плей-офф матча при выборке сетки (API: GET /:id/rounds/:roundId/games).
CREATE INDEX "broadcast_games_round_id_bracket_pair_id_idx"
  ON "broadcast_games"("round_id", "bracket_pair_id");
