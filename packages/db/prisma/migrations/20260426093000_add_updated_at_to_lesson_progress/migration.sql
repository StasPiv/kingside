-- KS-1955 (Lessons-redesign B6): добавляем updatedAt в прогрессы системных
-- курсов и уроков. Используется как источник lastActivityAt для Hero
-- Variant B («Последняя активность: N дней назад»).

ALTER TABLE "user_course_progress"
    ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "user_lesson_progress"
    ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
