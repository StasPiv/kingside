-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "archive_sources" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "schedule" TEXT,
    "cursor" TEXT,
    "last_run_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_error" TEXT,
    "total_games" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "archive_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_imports" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "file_name" TEXT,
    "cursor_before" TEXT,
    "cursor_after" TEXT,
    "games_parsed" INTEGER NOT NULL DEFAULT 0,
    "games_added" INTEGER NOT NULL DEFAULT 0,
    "games_skipped" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "archive_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_games" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "import_id" UUID,
    "content_hash" BYTEA NOT NULL,
    "event" TEXT,
    "site" TEXT,
    "round" TEXT,
    "date" TEXT,
    "played_at" TIMESTAMP(3),
    "white_name" TEXT,
    "black_name" TEXT,
    "white_elo" INTEGER,
    "black_elo" INTEGER,
    "white_title" TEXT,
    "black_title" TEXT,
    "result" TEXT,
    "eco" TEXT,
    "opening" TEXT,
    "ply_count" INTEGER,
    "pgn" TEXT NOT NULL,
    "final_fen" TEXT,
    "time_control" TEXT,
    "category" TEXT NOT NULL DEFAULT 'unknown',
    "is_classical" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archive_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_stats" (
    "position_key" BYTEA NOT NULL,
    "next_move_uci" TEXT NOT NULL,
    "bucket" TEXT NOT NULL DEFAULT 'master',
    "white_wins" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "black_wins" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "avg_elo" INTEGER,
    "last_seen_at" TIMESTAMP(3),
    "ply" INTEGER,

    CONSTRAINT "position_stats_pkey" PRIMARY KEY ("position_key","next_move_uci","bucket")
);

-- CreateTable
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

    CONSTRAINT "archive_game_positions_pkey" PRIMARY KEY ("position_key","bucket","game_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "archive_sources_code_key" ON "archive_sources"("code");

-- CreateIndex
CREATE INDEX "archive_imports_source_id_idx" ON "archive_imports"("source_id");

-- CreateIndex
CREATE INDEX "archive_imports_status_idx" ON "archive_imports"("status");

-- CreateIndex
CREATE UNIQUE INDEX "archive_games_content_hash_key" ON "archive_games"("content_hash");

-- CreateIndex
CREATE INDEX "archive_games_eco_played_at_idx" ON "archive_games"("eco", "played_at" DESC);

-- CreateIndex
CREATE INDEX "archive_games_white_name_black_name_idx" ON "archive_games"("white_name", "black_name");

-- CreateIndex
CREATE INDEX "archive_games_played_at_idx" ON "archive_games"("played_at" DESC);

-- CreateIndex
CREATE INDEX "archive_games_source_id_played_at_idx" ON "archive_games"("source_id", "played_at" DESC);

-- CreateIndex
CREATE INDEX "position_stats_position_key_bucket_total_idx" ON "position_stats"("position_key", "bucket", "total" DESC);

-- CreateIndex
CREATE INDEX "position_stats_ply_idx" ON "position_stats"("ply");

-- CreateIndex
CREATE INDEX "archive_game_positions_recent" ON "archive_game_positions"("position_key", "bucket", "played_at" DESC, "game_id" DESC);

-- CreateIndex
CREATE INDEX "archive_game_positions_top_elo" ON "archive_game_positions"("position_key", "bucket", "avg_elo" DESC, "game_id" DESC);

-- AddForeignKey
ALTER TABLE "archive_imports" ADD CONSTRAINT "archive_imports_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "archive_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_games" ADD CONSTRAINT "archive_games_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "archive_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_games" ADD CONSTRAINT "archive_games_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "archive_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

