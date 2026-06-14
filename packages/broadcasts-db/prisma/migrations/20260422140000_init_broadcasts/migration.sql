-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" UUID NOT NULL,
    "lichess_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "format" TEXT,
    "time_control" TEXT,
    "location" TEXT,
    "players" TEXT,
    "website" TEXT,
    "standings_url" TEXT,
    "image_url" TEXT,
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "streams" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_rounds" (
    "id" UUID NOT NULL,
    "broadcast_id" UUID NOT NULL,
    "lichess_round_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "broadcast_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_games" (
    "id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "lichess_game_id" TEXT,
    "white_player" TEXT,
    "black_player" TEXT,
    "white_elo" INTEGER,
    "black_elo" INTEGER,
    "result" TEXT,
    "pgn" TEXT,
    "current_fen" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcast_games_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "broadcasts_lichess_id_key" ON "broadcasts"("lichess_id");

-- CreateIndex
CREATE INDEX "broadcasts_is_active_idx" ON "broadcasts"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_rounds_lichess_round_id_key" ON "broadcast_rounds"("lichess_round_id");

-- CreateIndex
CREATE INDEX "broadcast_rounds_broadcast_id_idx" ON "broadcast_rounds"("broadcast_id");

-- CreateIndex
CREATE INDEX "broadcast_games_round_id_idx" ON "broadcast_games"("round_id");

-- AddForeignKey
ALTER TABLE "broadcast_rounds" ADD CONSTRAINT "broadcast_rounds_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_games" ADD CONSTRAINT "broadcast_games_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "broadcast_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
