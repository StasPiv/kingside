-- CreateEnum
CREATE TYPE "FriendshipStatus" AS ENUM ('pending', 'accepted', 'declined');

-- CreateEnum
CREATE TYPE "TournamentType" AS ENUM ('arena', 'swiss');

-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('upcoming', 'active', 'finished', 'cancelled');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "rating_puzzle" INTEGER NOT NULL DEFAULT 1500;

-- CreateTable
CREATE TABLE "friendships" (
    "id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "receiver_id" UUID NOT NULL,
    "status" "FriendshipStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "puzzles" (
    "id" TEXT NOT NULL,
    "fen" TEXT NOT NULL,
    "moves" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "rating_dev" INTEGER NOT NULL,
    "popularity" INTEGER NOT NULL,
    "nb_plays" INTEGER NOT NULL,
    "themes" TEXT NOT NULL,
    "game_url" TEXT NOT NULL,
    "opening_tags" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "puzzles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "puzzle_attempts" (
    "id" UUID NOT NULL,
    "puzzle_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "solved" BOOLEAN NOT NULL,
    "time_ms" INTEGER NOT NULL,
    "rating_before" INTEGER NOT NULL,
    "rating_after" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "puzzle_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "puzzle_rush_scores" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "time_mode" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "puzzle_rush_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournaments" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "TournamentType" NOT NULL,
    "status" "TournamentStatus" NOT NULL DEFAULT 'upcoming',
    "time_control_type" "TimeControlType" NOT NULL,
    "time_initial_sec" INTEGER NOT NULL,
    "time_increment_sec" INTEGER NOT NULL,
    "max_players" INTEGER,
    "rounds" INTEGER,
    "duration_minutes" INTEGER,
    "start_at" TIMESTAMP(3) NOT NULL,
    "finish_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_participants" (
    "id" UUID NOT NULL,
    "tournament_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tiebreak" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "games_played" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "rating_before" INTEGER,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_rounds" (
    "id" UUID NOT NULL,
    "tournament_id" UUID NOT NULL,
    "round_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "tournament_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_pairings" (
    "id" UUID NOT NULL,
    "tournament_id" UUID NOT NULL,
    "round_id" UUID,
    "game_id" UUID,
    "white_id" UUID NOT NULL,
    "black_id" UUID NOT NULL,
    "result" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "friendships_receiver_id_idx" ON "friendships"("receiver_id");

-- CreateIndex
CREATE UNIQUE INDEX "friendships_sender_id_receiver_id_key" ON "friendships"("sender_id", "receiver_id");

-- CreateIndex
CREATE INDEX "puzzles_rating_idx" ON "puzzles"("rating");

-- CreateIndex
CREATE INDEX "puzzle_attempts_user_id_idx" ON "puzzle_attempts"("user_id");

-- CreateIndex
CREATE INDEX "puzzle_attempts_puzzle_id_idx" ON "puzzle_attempts"("puzzle_id");

-- CreateIndex
CREATE INDEX "puzzle_attempts_user_id_created_at_idx" ON "puzzle_attempts"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "puzzle_rush_scores_user_id_idx" ON "puzzle_rush_scores"("user_id");

-- CreateIndex
CREATE INDEX "puzzle_rush_scores_score_idx" ON "puzzle_rush_scores"("score");

-- CreateIndex
CREATE INDEX "tournaments_status_idx" ON "tournaments"("status");

-- CreateIndex
CREATE INDEX "tournaments_start_at_idx" ON "tournaments"("start_at");

-- CreateIndex
CREATE INDEX "tournament_participants_tournament_id_score_idx" ON "tournament_participants"("tournament_id", "score");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_participants_tournament_id_user_id_key" ON "tournament_participants"("tournament_id", "user_id");

-- CreateIndex
CREATE INDEX "tournament_rounds_tournament_id_idx" ON "tournament_rounds"("tournament_id");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_rounds_tournament_id_round_number_key" ON "tournament_rounds"("tournament_id", "round_number");

-- CreateIndex
CREATE INDEX "tournament_pairings_tournament_id_idx" ON "tournament_pairings"("tournament_id");

-- CreateIndex
CREATE INDEX "tournament_pairings_round_id_idx" ON "tournament_pairings"("round_id");

-- CreateIndex
CREATE INDEX "tournament_pairings_game_id_idx" ON "tournament_pairings"("game_id");

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_receiver_id_fkey" FOREIGN KEY ("receiver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "puzzle_attempts" ADD CONSTRAINT "puzzle_attempts_puzzle_id_fkey" FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "puzzle_attempts" ADD CONSTRAINT "puzzle_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "puzzle_rush_scores" ADD CONSTRAINT "puzzle_rush_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_participants" ADD CONSTRAINT "tournament_participants_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_participants" ADD CONSTRAINT "tournament_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_rounds" ADD CONSTRAINT "tournament_rounds_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_pairings" ADD CONSTRAINT "tournament_pairings_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_pairings" ADD CONSTRAINT "tournament_pairings_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "tournament_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_pairings" ADD CONSTRAINT "tournament_pairings_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_pairings" ADD CONSTRAINT "tournament_pairings_white_id_fkey" FOREIGN KEY ("white_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_pairings" ADD CONSTRAINT "tournament_pairings_black_id_fkey" FOREIGN KEY ("black_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
