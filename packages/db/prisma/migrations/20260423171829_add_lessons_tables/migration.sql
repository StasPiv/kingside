/*
  Warnings:

  - You are about to drop the `generated_puzzle_attempts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `generated_puzzles` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "generated_puzzle_attempts" DROP CONSTRAINT "generated_puzzle_attempts_puzzle_id_fkey";

-- DropForeignKey
ALTER TABLE "tournament_invites" DROP CONSTRAINT "tournament_invites_tournament_id_fkey";

-- AlterTable
ALTER TABLE "arena_tournament_entries" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "arena_tournaments" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "blocked_users" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "friendships" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "game_reports" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "live_tournaments" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "notifications" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "puzzle_attempts" ADD COLUMN     "hints_used" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "puzzle_rating_after" INTEGER,
ADD COLUMN     "puzzle_rating_before" INTEGER,
ADD COLUMN     "user_moves" TEXT;

-- AlterTable
ALTER TABLE "puzzles" ADD COLUMN     "accepted_moves" TEXT,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "created_by" UUID,
ADD COLUMN     "depth" INTEGER,
ADD COLUMN     "gap" INTEGER,
ADD COLUMN     "is_public" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'lichess',
ADD COLUMN     "source_id" TEXT,
ADD COLUMN     "source_metadata" TEXT,
ADD COLUMN     "source_move_num" INTEGER,
ADD COLUMN     "source_type" TEXT,
ALTER COLUMN "rating" SET DEFAULT 1500,
ALTER COLUMN "rating_dev" SET DEFAULT 350,
ALTER COLUMN "popularity" SET DEFAULT 0,
ALTER COLUMN "nb_plays" SET DEFAULT 0,
ALTER COLUMN "themes" SET DEFAULT '',
ALTER COLUMN "game_url" DROP NOT NULL,
ALTER COLUMN "opening_tags" DROP NOT NULL,
ALTER COLUMN "opening_tags" DROP DEFAULT;

-- AlterTable
ALTER TABLE "rating_history" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "saved_filters" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tournament_invites" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tournament_pairings" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tournament_rounds" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "puzzle_streak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rating_puzzle_dev" INTEGER NOT NULL DEFAULT 350;

-- DropTable
DROP TABLE "generated_puzzle_attempts";

-- DropTable
DROP TABLE "generated_puzzles";

-- CreateTable
CREATE TABLE "puzzle_rating_snapshots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "solved" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "puzzle_rating_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_assistant_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "email" TEXT,
    "title" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "page" TEXT,
    "user_agent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "vote_count" INTEGER NOT NULL DEFAULT 0,
    "up_count" INTEGER NOT NULL DEFAULT 0,
    "down_count" INTEGER NOT NULL DEFAULT 0,
    "comment_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_comments" (
    "id" UUID NOT NULL,
    "feedback_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_votes" (
    "id" UUID NOT NULL,
    "feedback_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'up',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "title_key" TEXT NOT NULL,
    "description_key" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lessons" (
    "id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "block_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title_key" TEXT NOT NULL,
    "summary_key" TEXT NOT NULL,
    "est_minutes" INTEGER NOT NULL DEFAULT 10,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_steps" (
    "id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_course_progress" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "current_lesson_id" UUID,

    CONSTRAINT "user_course_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_lesson_progress" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "mastered_at" TIMESTAMP(3),
    "score" INTEGER NOT NULL DEFAULT 0,
    "steps_state" JSONB NOT NULL,

    CONSTRAINT "user_lesson_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "puzzle_rating_snapshots_user_id_idx" ON "puzzle_rating_snapshots"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "puzzle_rating_snapshots_user_id_date_key" ON "puzzle_rating_snapshots"("user_id", "date");

-- CreateIndex
CREATE INDEX "chat_conversations_user_id_idx" ON "chat_conversations"("user_id");

-- CreateIndex
CREATE INDEX "chat_assistant_messages_conversation_id_idx" ON "chat_assistant_messages"("conversation_id");

-- CreateIndex
CREATE INDEX "feedback_status_idx" ON "feedback"("status");

-- CreateIndex
CREATE INDEX "feedback_created_at_idx" ON "feedback"("created_at");

-- CreateIndex
CREATE INDEX "feedback_type_idx" ON "feedback"("type");

-- CreateIndex
CREATE INDEX "feedback_vote_count_idx" ON "feedback"("vote_count");

-- CreateIndex
CREATE INDEX "feedback_comments_feedback_id_idx" ON "feedback_comments"("feedback_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_votes_feedback_id_user_id_key" ON "feedback_votes"("feedback_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "courses_slug_key" ON "courses"("slug");

-- CreateIndex
CREATE INDEX "courses_level_order_idx" ON "courses"("level", "order");

-- CreateIndex
CREATE INDEX "courses_is_published_idx" ON "courses"("is_published");

-- CreateIndex
CREATE INDEX "lessons_course_id_order_idx" ON "lessons"("course_id", "order");

-- CreateIndex
CREATE INDEX "lessons_course_id_block_key_order_idx" ON "lessons"("course_id", "block_key", "order");

-- CreateIndex
CREATE INDEX "lessons_is_published_idx" ON "lessons"("is_published");

-- CreateIndex
CREATE UNIQUE INDEX "lessons_course_id_slug_key" ON "lessons"("course_id", "slug");

-- CreateIndex
CREATE INDEX "lesson_steps_lesson_id_order_idx" ON "lesson_steps"("lesson_id", "order");

-- CreateIndex
CREATE INDEX "user_course_progress_user_id_idx" ON "user_course_progress"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_course_progress_user_id_course_id_key" ON "user_course_progress"("user_id", "course_id");

-- CreateIndex
CREATE INDEX "user_lesson_progress_user_id_idx" ON "user_lesson_progress"("user_id");

-- CreateIndex
CREATE INDEX "user_lesson_progress_user_id_completed_at_idx" ON "user_lesson_progress"("user_id", "completed_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_lesson_progress_user_id_lesson_id_key" ON "user_lesson_progress"("user_id", "lesson_id");

-- CreateIndex
CREATE INDEX "puzzle_attempts_user_id_puzzle_id_solved_idx" ON "puzzle_attempts"("user_id", "puzzle_id", "solved");

-- CreateIndex
CREATE INDEX "puzzles_source_idx" ON "puzzles"("source");

-- CreateIndex
CREATE INDEX "puzzles_created_by_idx" ON "puzzles"("created_by");

-- AddForeignKey
ALTER TABLE "puzzle_rating_snapshots" ADD CONSTRAINT "puzzle_rating_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_invites" ADD CONSTRAINT "tournament_invites_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "arena_tournaments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arena_tournament_entries" ADD CONSTRAINT "arena_tournament_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_assistant_messages" ADD CONSTRAINT "chat_assistant_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_comments" ADD CONSTRAINT "feedback_comments_feedback_id_fkey" FOREIGN KEY ("feedback_id") REFERENCES "feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_comments" ADD CONSTRAINT "feedback_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_feedback_id_fkey" FOREIGN KEY ("feedback_id") REFERENCES "feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_steps" ADD CONSTRAINT "lesson_steps_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_course_progress" ADD CONSTRAINT "user_course_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_course_progress" ADD CONSTRAINT "user_course_progress_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_lesson_progress" ADD CONSTRAINT "user_lesson_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_lesson_progress" ADD CONSTRAINT "user_lesson_progress_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
