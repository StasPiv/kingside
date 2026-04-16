-- Clean up unused tables (friendships, tournaments)
-- Note: puzzles table structure unchanged (kept original columns)

-- DropForeignKey
ALTER TABLE "friendships" DROP CONSTRAINT "friendships_receiver_id_fkey";
ALTER TABLE "friendships" DROP CONSTRAINT "friendships_sender_id_fkey";
ALTER TABLE "tournament_pairings" DROP CONSTRAINT "tournament_pairings_black_id_fkey";
ALTER TABLE "tournament_pairings" DROP CONSTRAINT "tournament_pairings_game_id_fkey";
ALTER TABLE "tournament_pairings" DROP CONSTRAINT "tournament_pairings_round_id_fkey";
ALTER TABLE "tournament_pairings" DROP CONSTRAINT "tournament_pairings_tournament_id_fkey";
ALTER TABLE "tournament_pairings" DROP CONSTRAINT "tournament_pairings_white_id_fkey";
ALTER TABLE "tournament_participants" DROP CONSTRAINT "tournament_participants_tournament_id_fkey";
ALTER TABLE "tournament_participants" DROP CONSTRAINT "tournament_participants_user_id_fkey";
ALTER TABLE "tournament_rounds" DROP CONSTRAINT "tournament_rounds_tournament_id_fkey";
ALTER TABLE "tournaments" DROP CONSTRAINT "tournaments_created_by_fkey";

-- DropTable
DROP TABLE "friendships";
DROP TABLE "tournament_pairings";
DROP TABLE "tournament_participants";
DROP TABLE "tournament_rounds";
DROP TABLE "tournaments";

-- DropEnum
DROP TYPE "FriendshipStatus";
DROP TYPE "TournamentStatus";
DROP TYPE "TournamentType";

-- CreateIndex
CREATE INDEX "puzzles_themes_idx" ON "puzzles"("themes");
