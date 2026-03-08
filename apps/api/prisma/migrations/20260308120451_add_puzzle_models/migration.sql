/*
  Warnings:

  - The primary key for the `puzzles` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `game_url` on the `puzzles` table. All the data in the column will be lost.
  - You are about to drop the column `nb_plays` on the `puzzles` table. All the data in the column will be lost.
  - You are about to drop the column `opening_tags` on the `puzzles` table. All the data in the column will be lost.
  - You are about to drop the column `popularity` on the `puzzles` table. All the data in the column will be lost.
  - You are about to drop the column `rating_dev` on the `puzzles` table. All the data in the column will be lost.
  - The `themes` column on the `puzzles` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `friendships` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `puzzle_rush_scores` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `tournament_pairings` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `tournament_participants` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `tournament_rounds` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `tournaments` table. If the table is not empty, all the data it contains will be lost.
  - Changed the type of `puzzle_id` on the `puzzle_attempts` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `puzzles` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "friendships" DROP CONSTRAINT "friendships_receiver_id_fkey";

-- DropForeignKey
ALTER TABLE "friendships" DROP CONSTRAINT "friendships_sender_id_fkey";

-- DropForeignKey
ALTER TABLE "puzzle_attempts" DROP CONSTRAINT "puzzle_attempts_puzzle_id_fkey";

-- DropForeignKey
ALTER TABLE "puzzle_rush_scores" DROP CONSTRAINT "puzzle_rush_scores_user_id_fkey";

-- DropForeignKey
ALTER TABLE "tournament_pairings" DROP CONSTRAINT "tournament_pairings_black_id_fkey";

-- DropForeignKey
ALTER TABLE "tournament_pairings" DROP CONSTRAINT "tournament_pairings_game_id_fkey";

-- DropForeignKey
ALTER TABLE "tournament_pairings" DROP CONSTRAINT "tournament_pairings_round_id_fkey";

-- DropForeignKey
ALTER TABLE "tournament_pairings" DROP CONSTRAINT "tournament_pairings_tournament_id_fkey";

-- DropForeignKey
ALTER TABLE "tournament_pairings" DROP CONSTRAINT "tournament_pairings_white_id_fkey";

-- DropForeignKey
ALTER TABLE "tournament_participants" DROP CONSTRAINT "tournament_participants_tournament_id_fkey";

-- DropForeignKey
ALTER TABLE "tournament_participants" DROP CONSTRAINT "tournament_participants_user_id_fkey";

-- DropForeignKey
ALTER TABLE "tournament_rounds" DROP CONSTRAINT "tournament_rounds_tournament_id_fkey";

-- DropForeignKey
ALTER TABLE "tournaments" DROP CONSTRAINT "tournaments_created_by_fkey";

-- DropIndex
DROP INDEX "puzzle_attempts_user_id_created_at_idx";

-- AlterTable
ALTER TABLE "puzzle_attempts" DROP COLUMN "puzzle_id",
ADD COLUMN     "puzzle_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "puzzles" DROP CONSTRAINT "puzzles_pkey",
DROP COLUMN "game_url",
DROP COLUMN "nb_plays",
DROP COLUMN "opening_tags",
DROP COLUMN "popularity",
DROP COLUMN "rating_dev",
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "rating_deviation" INTEGER NOT NULL DEFAULT 350,
ADD COLUMN     "source" TEXT,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ALTER COLUMN "rating" SET DEFAULT 1500,
DROP COLUMN "themes",
ADD COLUMN     "themes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD CONSTRAINT "puzzles_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "friendships";

-- DropTable
DROP TABLE "puzzle_rush_scores";

-- DropTable
DROP TABLE "tournament_pairings";

-- DropTable
DROP TABLE "tournament_participants";

-- DropTable
DROP TABLE "tournament_rounds";

-- DropTable
DROP TABLE "tournaments";

-- DropEnum
DROP TYPE "FriendshipStatus";

-- DropEnum
DROP TYPE "TournamentStatus";

-- DropEnum
DROP TYPE "TournamentType";

-- CreateIndex
CREATE INDEX "puzzle_attempts_puzzle_id_idx" ON "puzzle_attempts"("puzzle_id");

-- AddForeignKey
ALTER TABLE "puzzle_attempts" ADD CONSTRAINT "puzzle_attempts_puzzle_id_fkey" FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
