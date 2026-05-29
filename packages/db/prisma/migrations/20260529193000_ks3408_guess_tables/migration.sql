-- KS-3408 / ADR-086 §6. Guess-the-Move: сессии угадывания ходов
-- (guess_sessions) + per-move детали (guess_moves) для review/истории
-- и будущего лидерборда. Образец — precision_attempts/_moves.
-- user_id — без FK-relation (как puzzle_rush_scores).

CREATE TABLE "guess_sessions" (
  "id"                       UUID NOT NULL,
  "user_id"                  UUID NOT NULL,
  "game_source"             TEXT NOT NULL,
  "game_ref"                TEXT,
  "pgn"                     TEXT,
  "side"                    TEXT NOT NULL,
  "status"                  TEXT NOT NULL DEFAULT 'active',
  "user_accuracy"           DOUBLE PRECISION,
  "player_accuracy"         DOUBLE PRECISION,
  "user_stars"              INTEGER,
  "score"                   INTEGER NOT NULL DEFAULT 0,
  "best_streak"             INTEGER NOT NULL DEFAULT 0,
  "better_than_player_count" INTEGER NOT NULL DEFAULT 0,
  "started_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"             TIMESTAMP(3),

  CONSTRAINT "guess_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "guess_sessions_user_id_finished_at_idx"
  ON "guess_sessions"("user_id", "finished_at");

CREATE TABLE "guess_moves" (
  "session_id"      UUID NOT NULL,
  "ply"             INTEGER NOT NULL,
  "fen_before"      TEXT NOT NULL,
  "played_uci"      TEXT NOT NULL,
  "user_uci"        TEXT NOT NULL,
  "best_uci"        TEXT NOT NULL,
  "e_before"        DOUBLE PRECISION NOT NULL,
  "e_after_played"  DOUBLE PRECISION NOT NULL,
  "e_after_user"    DOUBLE PRECISION NOT NULL,
  "loss_player"     DOUBLE PRECISION NOT NULL,
  "loss_user"       DOUBLE PRECISION NOT NULL,
  "accuracy_player" DOUBLE PRECISION NOT NULL,
  "accuracy_user"   DOUBLE PRECISION NOT NULL,
  "user_class"      TEXT NOT NULL,
  "verdict"         TEXT NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guess_moves_pkey" PRIMARY KEY ("session_id", "ply"),
  CONSTRAINT "guess_moves_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "guess_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "guess_moves_verdict_idx" ON "guess_moves"("verdict");
