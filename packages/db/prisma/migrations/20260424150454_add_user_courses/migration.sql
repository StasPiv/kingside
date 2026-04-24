-- CreateTable
CREATE TABLE "user_courses" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_lessons" (
    "id" UUID NOT NULL,
    "user_course_id" UUID NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "est_minutes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_lesson_steps" (
    "id" UUID NOT NULL,
    "user_lesson_id" UUID NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_lesson_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_course_play_progress" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "user_course_id" UUID NOT NULL,
    "completed_lessons_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "user_course_play_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_lesson_play_progress" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "user_lesson_id" UUID NOT NULL,
    "completed_steps_count" INTEGER NOT NULL DEFAULT 0,
    "total_steps" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "user_lesson_play_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_courses_slug_key" ON "user_courses"("slug");

-- CreateIndex
CREATE INDEX "user_courses_owner_id_is_public_idx" ON "user_courses"("owner_id", "is_public");

-- CreateIndex
CREATE INDEX "user_lessons_user_course_id_order_idx" ON "user_lessons"("user_course_id", "order");

-- CreateIndex
CREATE INDEX "user_lesson_steps_user_lesson_id_order_idx" ON "user_lesson_steps"("user_lesson_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "user_course_play_progress_user_id_user_course_id_key" ON "user_course_play_progress"("user_id", "user_course_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_lesson_play_progress_user_id_user_lesson_id_key" ON "user_lesson_play_progress"("user_id", "user_lesson_id");

-- AddForeignKey
ALTER TABLE "user_courses" ADD CONSTRAINT "user_courses_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_lessons" ADD CONSTRAINT "user_lessons_user_course_id_fkey" FOREIGN KEY ("user_course_id") REFERENCES "user_courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_lesson_steps" ADD CONSTRAINT "user_lesson_steps_user_lesson_id_fkey" FOREIGN KEY ("user_lesson_id") REFERENCES "user_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_course_play_progress" ADD CONSTRAINT "user_course_play_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_course_play_progress" ADD CONSTRAINT "user_course_play_progress_user_course_id_fkey" FOREIGN KEY ("user_course_id") REFERENCES "user_courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_lesson_play_progress" ADD CONSTRAINT "user_lesson_play_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_lesson_play_progress" ADD CONSTRAINT "user_lesson_play_progress_user_lesson_id_fkey" FOREIGN KEY ("user_lesson_id") REFERENCES "user_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
