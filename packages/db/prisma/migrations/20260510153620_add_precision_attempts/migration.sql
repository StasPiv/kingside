-- KS-2717 / ADR-056 §3. Доменный слой precision-метрик.
--
-- Две новые таблицы:
--   precision_attempts(attempt_id PK = puzzle_attempts.id) — 1:1 сводка
--   precision_attempt_moves(attempt_id, ply PK) — per-move детали
--
-- Без CONCURRENTLY (KS-2608: договорились писать стандартные миграции,
-- иначе schema.prisma vs БД дрейфит).

-- CreateTable: precision_attempts
CREATE TABLE "precision_attempts" (
    "attempt_id" UUID NOT NULL,
    "wdl_at_start_signed" DOUBLE PRECISION NOT NULL,
    "wdl_at_end_signed" DOUBLE PRECISION NOT NULL,
    "half_moves_played" INTEGER NOT NULL,
    "half_moves_target" INTEGER NOT NULL,
    "accuracy_percent" DOUBLE PRECISION NOT NULL,
    "best_moves_count" INTEGER NOT NULL,
    "good_moves_count" INTEGER NOT NULL,
    "inaccuracies_count" INTEGER NOT NULL,
    "mistakes_count" INTEGER NOT NULL,
    "blunders_count" INTEGER NOT NULL,
    "first_mistake_ply" INTEGER,
    "wdl_leak_sum" DOUBLE PRECISION NOT NULL,
    "end_reason" TEXT NOT NULL,

    CONSTRAINT "precision_attempts_pkey" PRIMARY KEY ("attempt_id")
);

-- CreateIndex
CREATE INDEX "precision_attempts_accuracy_percent_idx"
    ON "precision_attempts"("accuracy_percent");
CREATE INDEX "precision_attempts_end_reason_idx"
    ON "precision_attempts"("end_reason");

-- AddForeignKey: 1:1 с puzzle_attempts.
ALTER TABLE "precision_attempts"
    ADD CONSTRAINT "precision_attempts_attempt_id_fkey"
    FOREIGN KEY ("attempt_id") REFERENCES "puzzle_attempts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: precision_attempt_moves
CREATE TABLE "precision_attempt_moves" (
    "attempt_id" UUID NOT NULL,
    "ply" INTEGER NOT NULL,
    "fen_before" TEXT NOT NULL,
    "played_uci" TEXT NOT NULL,
    "best_uci" TEXT NOT NULL,
    "cp_before" INTEGER,
    "cp_after" INTEGER,
    "wdl_before_w" INTEGER,
    "wdl_before_d" INTEGER,
    "wdl_before_l" INTEGER,
    "wdl_after_w" INTEGER,
    "wdl_after_d" INTEGER,
    "wdl_after_l" INTEGER,
    "depth" INTEGER,
    "classification" TEXT NOT NULL,

    CONSTRAINT "precision_attempt_moves_pkey" PRIMARY KEY ("attempt_id", "ply")
);

-- CreateIndex
CREATE INDEX "precision_attempt_moves_classification_idx"
    ON "precision_attempt_moves"("classification");

-- AddForeignKey
ALTER TABLE "precision_attempt_moves"
    ADD CONSTRAINT "precision_attempt_moves_attempt_id_fkey"
    FOREIGN KEY ("attempt_id") REFERENCES "precision_attempts"("attempt_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
