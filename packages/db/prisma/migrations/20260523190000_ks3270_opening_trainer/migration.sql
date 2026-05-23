-- KS-3270 / ADR-077 §2.2, §2.6.
-- Базовые таблицы Opening Trainer'а (M1): репертуары, сессии, попытки.
-- `OpeningLineProgress` (per-path прогресс + SM-2) — в M2, отдельной миграцией.

-- CreateTable
CREATE TABLE "opening_repertoires" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "pgn" TEXT NOT NULL,
    "tree" JSONB NOT NULL,
    "node_count" INTEGER NOT NULL DEFAULT 0,
    "edge_count" INTEGER NOT NULL DEFAULT 0,
    "max_depth" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "opening_repertoires_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_trainer_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "repertoire_id" UUID NOT NULL,
    "side" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "repeat_mode" TEXT NOT NULL DEFAULT 'complete',
    "status" TEXT NOT NULL DEFAULT 'active',
    "played_lines" JSONB NOT NULL DEFAULT '{}',
    "current_fen" TEXT NOT NULL,
    "current_path" JSONB NOT NULL DEFAULT '[]',
    "score" INTEGER NOT NULL DEFAULT 0,
    "moves_played" INTEGER NOT NULL DEFAULT 0,
    "correct_moves" INTEGER NOT NULL DEFAULT 0,
    "wrong_moves" INTEGER NOT NULL DEFAULT 0,
    "hints_used" INTEGER NOT NULL DEFAULT 0,
    "streak_max" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "opening_trainer_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_trainer_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "position_fen" TEXT NOT NULL,
    "expected_moves" JSONB NOT NULL,
    "user_move" TEXT NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "hint_used" BOOLEAN NOT NULL DEFAULT false,
    "score_delta" INTEGER NOT NULL,
    "response_time_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opening_trainer_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: лобби-выборка + sort by createdAt DESC.
CREATE INDEX "opening_repertoires_user_id_created_at_idx" ON "opening_repertoires"("user_id", "created_at" DESC);

-- CreateIndex: cleanup job для hard-delete soft-deleted записей (M2).
CREATE INDEX "opening_repertoires_deleted_at_idx" ON "opening_repertoires"("deleted_at");

-- CreateIndex: лобби-вкладка «мои активные сессии», resume-список.
CREATE INDEX "opening_trainer_sessions_user_id_repertoire_id_finished_at_idx" ON "opening_trainer_sessions"("user_id", "repertoire_id", "finished_at");

-- CreateIndex: аналитика per-репертуар.
CREATE INDEX "opening_trainer_sessions_repertoire_id_status_idx" ON "opening_trainer_sessions"("repertoire_id", "status");

-- CreateIndex: auto-expire job (24h inactivity) использует (status, last_activity_at).
CREATE INDEX "opening_trainer_sessions_status_last_activity_at_idx" ON "opening_trainer_sessions"("status", "last_activity_at");

-- CreateIndex: чтение попыток сессии в хронологическом порядке.
CREATE INDEX "opening_trainer_attempts_session_id_created_at_idx" ON "opening_trainer_attempts"("session_id", "created_at");

-- AddForeignKey
ALTER TABLE "opening_repertoires" ADD CONSTRAINT "opening_repertoires_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_trainer_sessions" ADD CONSTRAINT "opening_trainer_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_trainer_sessions" ADD CONSTRAINT "opening_trainer_sessions_repertoire_id_fkey" FOREIGN KEY ("repertoire_id") REFERENCES "opening_repertoires"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_trainer_attempts" ADD CONSTRAINT "opening_trainer_attempts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "opening_trainer_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
