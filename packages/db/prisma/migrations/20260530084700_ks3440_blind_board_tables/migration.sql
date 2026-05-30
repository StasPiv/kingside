-- KS-3440 / ADR-088 §10. Blind-board: сессии (позиция держится только
-- на сервере, анти-чит §5) + per-round audit. Образец guess_sessions/
-- guess_moves: user_id без FK, cascade-delete attempts→session.
-- Также добавляем User.blind_board_best_streak (для лидерборда §7).

ALTER TABLE "users"
  ADD COLUMN "blind_board_best_streak" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "blind_board_sessions" (
  "id"                  UUID NOT NULL,
  "user_id"             UUID,
  "start_position"      JSONB NOT NULL,
  "current_position"    JSONB NOT NULL,
  "next_target_piece"   JSONB,
  "streak"              INTEGER NOT NULL DEFAULT 0,
  "best_streak"         INTEGER NOT NULL DEFAULT 0,
  "status"              TEXT NOT NULL DEFAULT 'active',
  "finish_reason"       TEXT,
  "started_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"         TIMESTAMP(3),

  CONSTRAINT "blind_board_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "blind_board_sessions_user_id_finished_at_idx"
  ON "blind_board_sessions"("user_id", "finished_at");

CREATE TABLE "blind_board_attempts" (
  "id"                   UUID NOT NULL,
  "session_id"           UUID NOT NULL,
  "round"                INTEGER NOT NULL,
  "comp_move_from"       TEXT NOT NULL,
  "comp_move_to"         TEXT NOT NULL,
  "expected_square"      TEXT NOT NULL,
  "expected_piece_type"  TEXT NOT NULL,
  "user_square"          TEXT,
  "user_piece_type"      TEXT,
  "correct"              BOOLEAN NOT NULL,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "blind_board_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "blind_board_attempts_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "blind_board_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "blind_board_attempts_session_id_round_idx"
  ON "blind_board_attempts"("session_id", "round");
