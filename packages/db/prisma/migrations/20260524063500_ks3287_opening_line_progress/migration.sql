-- KS-3287 (M2 §2.5 ADR-077). Per-path прогресс линий репертуара —
-- counter подряд правильных, mastered-флаг, SM-2 поля для review-режима.

CREATE TABLE "opening_line_progress" (
    "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id"              UUID NOT NULL,
    "repertoire_id"        UUID NOT NULL,
    "path_hash"            TEXT NOT NULL,
    "path_uci"             JSONB NOT NULL,
    "path_length"          INTEGER NOT NULL,
    "correct_count"        INTEGER NOT NULL DEFAULT 0,
    "wrong_count"          INTEGER NOT NULL DEFAULT 0,
    "consecutive_correct"  INTEGER NOT NULL DEFAULT 0,
    "last_played_at"       TIMESTAMP(3) NOT NULL,
    "mastered_at"          TIMESTAMP(3),
    "sm2_easiness"         DOUBLE PRECISION,
    "sm2_interval"         INTEGER,
    "sm2_due_at"           TIMESTAMP(3),
    "sm2_reps"             INTEGER,
    "orphaned"             BOOLEAN NOT NULL DEFAULT FALSE,

    CONSTRAINT "opening_line_progress_pkey" PRIMARY KEY ("id")
);

-- Уникальная запись на (user × repertoire × path).
CREATE UNIQUE INDEX "opening_line_progress_user_repertoire_path_unique"
  ON "opening_line_progress" ("user_id", "repertoire_id", "path_hash");

-- Выборка всех линий репертуара пользователя (GET /repertoires/:id/progress).
CREATE INDEX "opening_line_progress_user_repertoire_idx"
  ON "opening_line_progress" ("user_id", "repertoire_id");

-- SRS-очередь «к повтору сегодня» (GET /reviews/due, KS-3290 B4).
CREATE INDEX "opening_line_progress_user_due_idx"
  ON "opening_line_progress" ("user_id", "sm2_due_at");

-- FK CASCADE до пользователя и репертуара.
ALTER TABLE "opening_line_progress"
  ADD CONSTRAINT "opening_line_progress_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "opening_line_progress"
  ADD CONSTRAINT "opening_line_progress_repertoire_id_fkey"
  FOREIGN KEY ("repertoire_id") REFERENCES "opening_repertoires"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
