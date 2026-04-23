-- L-03 (KS-1758): добавляет 5 таблиц раздела «Уроки» (ADR-024 §2.1).
-- Источник истины shape payload'а: packages/shared/src/types/lessons.ts.

-- ───── CreateTable ────────────────────────────────────────────────────

CREATE TABLE "courses" (
    "id"              UUID         NOT NULL,
    "slug"            TEXT         NOT NULL,
    "level"           TEXT         NOT NULL,
    "title_key"       TEXT         NOT NULL,
    "description_key" TEXT         NOT NULL,
    "order"           INTEGER      NOT NULL DEFAULT 0,
    "is_published"    BOOLEAN      NOT NULL DEFAULT false,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lessons" (
    "id"           UUID         NOT NULL,
    "course_id"    UUID         NOT NULL,
    "slug"         TEXT         NOT NULL,
    "order"        INTEGER      NOT NULL DEFAULT 0,
    "block_key"    TEXT         NOT NULL,
    "kind"         TEXT         NOT NULL,
    "title_key"    TEXT         NOT NULL,
    "summary_key"  TEXT         NOT NULL,
    "est_minutes"  INTEGER      NOT NULL DEFAULT 10,
    "is_published" BOOLEAN      NOT NULL DEFAULT false,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lesson_steps" (
    "id"         UUID         NOT NULL,
    "lesson_id"  UUID         NOT NULL,
    "order"      INTEGER      NOT NULL DEFAULT 0,
    "type"       TEXT         NOT NULL,
    "payload"    JSONB        NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_course_progress" (
    "id"                UUID         NOT NULL,
    "user_id"           UUID         NOT NULL,
    "course_id"         UUID         NOT NULL,
    "started_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"      TIMESTAMP(3),
    "current_lesson_id" UUID,

    CONSTRAINT "user_course_progress_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_lesson_progress" (
    "id"           UUID         NOT NULL,
    "user_id"      UUID         NOT NULL,
    "lesson_id"    UUID         NOT NULL,
    "started_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "mastered_at"  TIMESTAMP(3),
    "score"        INTEGER      NOT NULL DEFAULT 0,
    "steps_state"  JSONB        NOT NULL,

    CONSTRAINT "user_lesson_progress_pkey" PRIMARY KEY ("id")
);

-- ───── CreateIndex ────────────────────────────────────────────────────

CREATE UNIQUE INDEX "courses_slug_key"         ON "courses"("slug");
CREATE INDEX        "courses_level_order_idx"  ON "courses"("level", "order");
CREATE INDEX        "courses_is_published_idx" ON "courses"("is_published");

CREATE INDEX        "lessons_course_id_order_idx"           ON "lessons"("course_id", "order");
CREATE INDEX        "lessons_course_id_block_key_order_idx" ON "lessons"("course_id", "block_key", "order");
CREATE INDEX        "lessons_is_published_idx"              ON "lessons"("is_published");
CREATE UNIQUE INDEX "lessons_course_id_slug_key"            ON "lessons"("course_id", "slug");

CREATE INDEX        "lesson_steps_lesson_id_order_idx" ON "lesson_steps"("lesson_id", "order");

CREATE INDEX        "user_course_progress_user_id_idx"           ON "user_course_progress"("user_id");
CREATE UNIQUE INDEX "user_course_progress_user_id_course_id_key" ON "user_course_progress"("user_id", "course_id");

CREATE INDEX        "user_lesson_progress_user_id_idx"              ON "user_lesson_progress"("user_id");
CREATE INDEX        "user_lesson_progress_user_id_completed_at_idx" ON "user_lesson_progress"("user_id", "completed_at");
CREATE UNIQUE INDEX "user_lesson_progress_user_id_lesson_id_key"    ON "user_lesson_progress"("user_id", "lesson_id");

-- ───── AddForeignKey ──────────────────────────────────────────────────

ALTER TABLE "lessons"
    ADD CONSTRAINT "lessons_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lesson_steps"
    ADD CONSTRAINT "lesson_steps_lesson_id_fkey"
    FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_course_progress"
    ADD CONSTRAINT "user_course_progress_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_course_progress"
    ADD CONSTRAINT "user_course_progress_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_lesson_progress"
    ADD CONSTRAINT "user_lesson_progress_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_lesson_progress"
    ADD CONSTRAINT "user_lesson_progress_lesson_id_fkey"
    FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
