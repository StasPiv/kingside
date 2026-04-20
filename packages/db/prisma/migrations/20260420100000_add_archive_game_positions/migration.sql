-- CreateTable archive_game_positions
CREATE TABLE "archive_game_positions" (
    "position_key" BYTEA NOT NULL,
    "bucket" TEXT NOT NULL,
    "game_id" UUID NOT NULL,
    "ply" SMALLINT NOT NULL,
    "move_uci" TEXT,
    "side_to_move" CHAR(1) NOT NULL,
    "played_at" TIMESTAMP(3),
    "avg_elo" SMALLINT,
    "result" CHAR(1),

    CONSTRAINT "archive_game_positions_pkey" PRIMARY KEY ("position_key", "bucket", "game_id")
);

-- CreateIndex
CREATE INDEX "archive_game_positions_recent" ON "archive_game_positions"("position_key", "bucket", "played_at" DESC, "game_id" DESC);

-- CreateIndex
CREATE INDEX "archive_game_positions_top_elo" ON "archive_game_positions"("position_key", "bucket", "avg_elo" DESC, "game_id" DESC);
