-- KS-4910 / ADR-162 §2.1. Занятия v2: персональный урок в занятии.
-- lesson_id — ссылка на собранный урок скрытого персонального курса
-- (без FK: урок чистится ротацией через 30 дней, сессия остаётся
-- историей; связь мягкая, как profileSnapshot).
-- score — результат completeLesson 0-100 (§5), вход адаптации.
ALTER TABLE "study_sessions"
    ADD COLUMN "lesson_id" UUID,
    ADD COLUMN "score" INTEGER;

-- role: main (урок занятия) | homework (домашнее задание, §5).
ALTER TABLE "study_tasks"
    ADD COLUMN "role" TEXT NOT NULL DEFAULT 'main';
