-- KS-4339 / ADR-135 §2.1. Раздел «Точность» — отдельный концепт пазлов
-- на Maia-difficulty. Полностью изолированная схема:
--   * tactic_puzzles — банк задач;
--   * tactic_puzzle_attempts — попытки пользователей с precision-метриками;
--   * tactic_user_mistakes — журнал «работа над ошибками»;
--   * user_tactic_ratings — пользовательский Glicko-1 рейтинг по разделу,
--     отдельная таблица по образцу user_precision_ratings (аргументы в
--     комментарии модели UserTacticRating в schema.prisma).
--
-- Старые puzzles / puzzle_attempts / precision_attempts не трогаем —
-- удаление legacy generated PVE вынесено в отдельную задачу T7.

-- CreateTable
CREATE TABLE "tactic_puzzles" (
    "id" UUID NOT NULL,
    "fen" TEXT NOT NULL,
    "best_move_uci" TEXT NOT NULL,
    "solver_side" TEXT NOT NULL,
    "best_e" DOUBLE PRECISION NOT NULL,
    "second_e" DOUBLE PRECISION NOT NULL,
    "gap" DOUBLE PRECISION NOT NULL,
    "difficulty" DOUBLE PRECISION NOT NULL,
    "wdl_w" INTEGER NOT NULL,
    "wdl_d" INTEGER NOT NULL,
    "wdl_l" INTEGER NOT NULL,
    "objective" TEXT NOT NULL,
    "themes" TEXT NOT NULL DEFAULT '',
    "rating" INTEGER NOT NULL DEFAULT 1500,
    "rating_dev" INTEGER NOT NULL DEFAULT 350,
    "popularity" INTEGER NOT NULL DEFAULT 0,
    "nb_plays" INTEGER NOT NULL DEFAULT 0,
    "source_game_id" UUID,
    "source_move_num" INTEGER,
    "source_white_elo" INTEGER,
    "source_black_elo" INTEGER,
    "source_headers" JSONB,
    "algorithm_version" TEXT NOT NULL DEFAULT 'maia-difficulty-v1',
    "maia_elo" INTEGER NOT NULL,
    "sf_main_nodes" INTEGER NOT NULL,
    "sf_verify_nodes" INTEGER NOT NULL,
    "sf_multi_pv" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tactic_puzzles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tactic_puzzle_attempts" (
    "id" UUID NOT NULL,
    "puzzle_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "solved" BOOLEAN NOT NULL,
    "time_ms" INTEGER NOT NULL,
    "rating_before" INTEGER NOT NULL,
    "rating_after" INTEGER NOT NULL,
    "puzzle_rating_before" INTEGER,
    "puzzle_rating_after" INTEGER,
    "line_half_moves" INTEGER NOT NULL,
    "user_moves" TEXT,
    "stop_reason" TEXT NOT NULL,
    "wdl_start" DOUBLE PRECISION,
    "wdl_end" DOUBLE PRECISION,
    "moves_accuracy" DOUBLE PRECISION,
    "precision_grade" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tactic_puzzle_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tactic_user_mistakes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "puzzle_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tactic_user_mistakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tactic_ratings" (
    "user_id" UUID NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 1500,
    "deviation" DOUBLE PRECISION NOT NULL DEFAULT 350,
    "volatility" DOUBLE PRECISION NOT NULL DEFAULT 0.06,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_tactic_ratings_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tactic_puzzles_fen_key" ON "tactic_puzzles"("fen");

-- CreateIndex
CREATE INDEX "tactic_puzzles_rating_idx" ON "tactic_puzzles"("rating");

-- CreateIndex
CREATE INDEX "tactic_puzzles_themes_idx" ON "tactic_puzzles"("themes");

-- CreateIndex
CREATE INDEX "tactic_puzzles_difficulty_idx" ON "tactic_puzzles"("difficulty");

-- CreateIndex
CREATE INDEX "tactic_puzzles_gap_idx" ON "tactic_puzzles"("gap");

-- CreateIndex
CREATE INDEX "tactic_puzzles_objective_rating_idx" ON "tactic_puzzles"("objective", "rating");

-- CreateIndex
CREATE INDEX "tactic_puzzles_algorithm_version_idx" ON "tactic_puzzles"("algorithm_version");

-- CreateIndex
CREATE INDEX "tactic_puzzle_attempts_user_id_idx" ON "tactic_puzzle_attempts"("user_id");

-- CreateIndex
CREATE INDEX "tactic_puzzle_attempts_puzzle_id_idx" ON "tactic_puzzle_attempts"("puzzle_id");

-- CreateIndex
CREATE INDEX "tactic_puzzle_attempts_user_id_created_at_idx" ON "tactic_puzzle_attempts"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "tactic_puzzle_attempts_user_id_puzzle_id_solved_idx" ON "tactic_puzzle_attempts"("user_id", "puzzle_id", "solved");

-- CreateIndex
CREATE INDEX "tactic_user_mistakes_user_id_resolved_idx" ON "tactic_user_mistakes"("user_id", "resolved");

-- CreateIndex
CREATE UNIQUE INDEX "tactic_user_mistakes_user_id_puzzle_id_key" ON "tactic_user_mistakes"("user_id", "puzzle_id");

-- AddForeignKey
ALTER TABLE "tactic_puzzle_attempts" ADD CONSTRAINT "tactic_puzzle_attempts_puzzle_id_fkey" FOREIGN KEY ("puzzle_id") REFERENCES "tactic_puzzles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tactic_puzzle_attempts" ADD CONSTRAINT "tactic_puzzle_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tactic_user_mistakes" ADD CONSTRAINT "tactic_user_mistakes_puzzle_id_fkey" FOREIGN KEY ("puzzle_id") REFERENCES "tactic_puzzles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tactic_user_mistakes" ADD CONSTRAINT "tactic_user_mistakes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tactic_ratings" ADD CONSTRAINT "user_tactic_ratings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
