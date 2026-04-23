-- Catch-up миграция: закрывает давний разрыв schema.prisma ↔ migrations,
-- существовавший до KS-1758 (модели feedback*, chat_*, puzzle_rating_snapshots,
-- доп. колонки puzzle_attempts/puzzles/users, DROP generated_puzzle*, и т. п.
-- присутствовали в schema.prisma, но без соответствующих SQL-миграций).
--
-- Полностью идемпотентна: IF NOT EXISTS / IF EXISTS / DO-блоки для FK.
-- На свежей dev-БД (после reset) создаёт всё с нуля; на БД, где эти объекты
-- уже физически существуют (prod или старый dev) — no-op.

-- ───── DropForeignKey ─────────────────────────────────────────────────

ALTER TABLE IF EXISTS "generated_puzzle_attempts" DROP CONSTRAINT IF EXISTS "generated_puzzle_attempts_puzzle_id_fkey";

ALTER TABLE IF EXISTS "tournament_invites" DROP CONSTRAINT IF EXISTS "tournament_invites_tournament_id_fkey";

-- ───── AlterTable: DROP DEFAULT на id ─────────────────────────────────

ALTER TABLE "arena_tournament_entries" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "arena_tournaments"        ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "blocked_users"            ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "friendships"              ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "game_reports"             ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "live_tournaments"         ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "notifications"            ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "rating_history"           ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "saved_filters"            ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "tournament_invites"       ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "tournament_pairings"      ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "tournament_rounds"        ALTER COLUMN "id" DROP DEFAULT;

-- ───── AlterTable: добавить колонки ───────────────────────────────────

ALTER TABLE "puzzle_attempts"
    ADD COLUMN IF NOT EXISTS "hints_used"           INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "puzzle_rating_after"  INTEGER,
    ADD COLUMN IF NOT EXISTS "puzzle_rating_before" INTEGER,
    ADD COLUMN IF NOT EXISTS "user_moves"           TEXT;

ALTER TABLE "puzzles"
    ADD COLUMN IF NOT EXISTS "accepted_moves"  TEXT,
    ADD COLUMN IF NOT EXISTS "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS "created_by"      UUID,
    ADD COLUMN IF NOT EXISTS "depth"           INTEGER,
    ADD COLUMN IF NOT EXISTS "gap"             INTEGER,
    ADD COLUMN IF NOT EXISTS "is_public"       BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "source"          TEXT NOT NULL DEFAULT 'lichess',
    ADD COLUMN IF NOT EXISTS "source_id"       TEXT,
    ADD COLUMN IF NOT EXISTS "source_metadata" TEXT,
    ADD COLUMN IF NOT EXISTS "source_move_num" INTEGER,
    ADD COLUMN IF NOT EXISTS "source_type"     TEXT;

ALTER TABLE "puzzles" ALTER COLUMN "rating"       SET DEFAULT 1500;
ALTER TABLE "puzzles" ALTER COLUMN "rating_dev"   SET DEFAULT 350;
ALTER TABLE "puzzles" ALTER COLUMN "popularity"   SET DEFAULT 0;
ALTER TABLE "puzzles" ALTER COLUMN "nb_plays"     SET DEFAULT 0;
ALTER TABLE "puzzles" ALTER COLUMN "themes"       SET DEFAULT '';
ALTER TABLE "puzzles" ALTER COLUMN "game_url"     DROP NOT NULL;
ALTER TABLE "puzzles" ALTER COLUMN "opening_tags" DROP NOT NULL;
ALTER TABLE "puzzles" ALTER COLUMN "opening_tags" DROP DEFAULT;

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "puzzle_streak"     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "rating_puzzle_dev" INTEGER NOT NULL DEFAULT 350;

-- ───── DropTable устаревших сущностей ─────────────────────────────────

DROP TABLE IF EXISTS "generated_puzzle_attempts" CASCADE;
DROP TABLE IF EXISTS "generated_puzzles"         CASCADE;

-- ───── CreateTable ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "puzzle_rating_snapshots" (
    "id"       UUID    NOT NULL,
    "user_id"  UUID    NOT NULL,
    "rating"   INTEGER NOT NULL,
    "date"     DATE    NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "solved"   INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "puzzle_rating_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chat_conversations" (
    "id"         UUID         NOT NULL,
    "user_id"    UUID         NOT NULL,
    "title"      TEXT         NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chat_assistant_messages" (
    "id"              UUID         NOT NULL,
    "conversation_id" UUID         NOT NULL,
    "role"            TEXT         NOT NULL,
    "content"         TEXT         NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_assistant_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "feedback" (
    "id"            UUID         NOT NULL,
    "user_id"       UUID,
    "email"         TEXT,
    "title"         TEXT,
    "type"          TEXT         NOT NULL,
    "message"       TEXT         NOT NULL,
    "page"          TEXT,
    "user_agent"    TEXT,
    "status"        TEXT         NOT NULL DEFAULT 'new',
    "is_public"     BOOLEAN      NOT NULL DEFAULT true,
    "vote_count"    INTEGER      NOT NULL DEFAULT 0,
    "up_count"      INTEGER      NOT NULL DEFAULT 0,
    "down_count"    INTEGER      NOT NULL DEFAULT 0,
    "comment_count" INTEGER      NOT NULL DEFAULT 0,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "feedback_comments" (
    "id"          UUID         NOT NULL,
    "feedback_id" UUID         NOT NULL,
    "user_id"     UUID         NOT NULL,
    "message"     TEXT         NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "feedback_votes" (
    "id"          UUID         NOT NULL,
    "feedback_id" UUID         NOT NULL,
    "user_id"     UUID         NOT NULL,
    "direction"   TEXT         NOT NULL DEFAULT 'up',
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_votes_pkey" PRIMARY KEY ("id")
);

-- ───── CreateIndex ────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "puzzle_rating_snapshots_user_id_idx"      ON "puzzle_rating_snapshots"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "puzzle_rating_snapshots_user_id_date_key" ON "puzzle_rating_snapshots"("user_id", "date");

CREATE INDEX IF NOT EXISTS "chat_conversations_user_id_idx"                  ON "chat_conversations"("user_id");

CREATE INDEX IF NOT EXISTS "chat_assistant_messages_conversation_id_idx"     ON "chat_assistant_messages"("conversation_id");

CREATE INDEX IF NOT EXISTS "feedback_status_idx"                             ON "feedback"("status");
CREATE INDEX IF NOT EXISTS "feedback_created_at_idx"                         ON "feedback"("created_at");
CREATE INDEX IF NOT EXISTS "feedback_type_idx"                               ON "feedback"("type");
CREATE INDEX IF NOT EXISTS "feedback_vote_count_idx"                         ON "feedback"("vote_count");

CREATE INDEX IF NOT EXISTS "feedback_comments_feedback_id_idx"               ON "feedback_comments"("feedback_id");

CREATE UNIQUE INDEX IF NOT EXISTS "feedback_votes_feedback_id_user_id_key"   ON "feedback_votes"("feedback_id", "user_id");

CREATE INDEX IF NOT EXISTS "puzzle_attempts_user_id_puzzle_id_solved_idx"    ON "puzzle_attempts"("user_id", "puzzle_id", "solved");

CREATE INDEX IF NOT EXISTS "puzzles_source_idx"                              ON "puzzles"("source");
CREATE INDEX IF NOT EXISTS "puzzles_created_by_idx"                          ON "puzzles"("created_by");

-- ───── AddForeignKey (идемпотентно через DO-блоки) ────────────────────

DO $$ BEGIN
  ALTER TABLE "puzzle_rating_snapshots"
    ADD CONSTRAINT "puzzle_rating_snapshots_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "tournament_invites"
    ADD CONSTRAINT "tournament_invites_tournament_id_fkey"
    FOREIGN KEY ("tournament_id") REFERENCES "arena_tournaments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "arena_tournament_entries"
    ADD CONSTRAINT "arena_tournament_entries_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "chat_conversations"
    ADD CONSTRAINT "chat_conversations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "chat_assistant_messages"
    ADD CONSTRAINT "chat_assistant_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "feedback"
    ADD CONSTRAINT "feedback_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "feedback_comments"
    ADD CONSTRAINT "feedback_comments_feedback_id_fkey"
    FOREIGN KEY ("feedback_id") REFERENCES "feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "feedback_comments"
    ADD CONSTRAINT "feedback_comments_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "feedback_votes"
    ADD CONSTRAINT "feedback_votes_feedback_id_fkey"
    FOREIGN KEY ("feedback_id") REFERENCES "feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
