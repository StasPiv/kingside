-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('waiting', 'active', 'finished', 'aborted');

-- CreateEnum
CREATE TYPE "GameResult" AS ENUM ('white', 'black', 'draw');

-- CreateEnum
CREATE TYPE "Termination" AS ENUM ('checkmate', 'resignation', 'timeout', 'draw_agreement', 'stalemate', 'insufficient', 'repetition', 'fifty_moves', 'abort');

-- CreateEnum
CREATE TYPE "TimeControlType" AS ENUM ('bullet', 'blitz', 'rapid', 'classical');

-- CreateEnum
CREATE TYPE "PieceColor" AS ENUM ('white', 'black');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "rating_bullet" INTEGER NOT NULL DEFAULT 1500,
    "rating_blitz" INTEGER NOT NULL DEFAULT 1500,
    "rating_rapid" INTEGER NOT NULL DEFAULT 1500,
    "rating_classical" INTEGER NOT NULL DEFAULT 1500,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "white_id" UUID NOT NULL,
    "black_id" UUID NOT NULL,
    "status" "GameStatus" NOT NULL DEFAULT 'waiting',
    "result" "GameResult",
    "termination" "Termination",
    "time_control_type" "TimeControlType" NOT NULL,
    "time_initial_sec" INTEGER NOT NULL,
    "time_increment_sec" INTEGER NOT NULL,
    "pgn" TEXT,
    "final_fen" TEXT,
    "white_rating_before" INTEGER,
    "black_rating_before" INTEGER,
    "white_rating_after" INTEGER,
    "black_rating_after" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moves" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "move_number" INTEGER NOT NULL,
    "color" "PieceColor" NOT NULL,
    "uci" TEXT NOT NULL,
    "san" TEXT NOT NULL,
    "fen_after" TEXT NOT NULL,
    "time_left_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "games_white_id_idx" ON "games"("white_id");

-- CreateIndex
CREATE INDEX "games_black_id_idx" ON "games"("black_id");

-- CreateIndex
CREATE INDEX "games_status_idx" ON "games"("status");

-- CreateIndex
CREATE INDEX "games_created_at_idx" ON "games"("created_at");

-- CreateIndex
CREATE INDEX "moves_game_id_move_number_idx" ON "moves"("game_id", "move_number");

-- CreateIndex
CREATE INDEX "chat_messages_game_id_idx" ON "chat_messages"("game_id");

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_white_id_fkey" FOREIGN KEY ("white_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_black_id_fkey" FOREIGN KEY ("black_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moves" ADD CONSTRAINT "moves_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
