-- KS-1964 (Admin API B-2): inline-поля для Course и Lesson.
-- Все поля nullable: существующие курсы не ломаются, UI/сервис при
-- маппинге используют их с приоритетом над `*Key` (i18n) — fallback
-- остаётся, см. KS-1965/B-3/B-4.

ALTER TABLE "courses"
    ADD COLUMN "title"       TEXT,
    ADD COLUMN "description" TEXT,
    ADD COLUMN "audience"    TEXT,
    ADD COLUMN "hook"        TEXT,
    ADD COLUMN "outcome"     TEXT;

ALTER TABLE "lessons"
    ADD COLUMN "title"   TEXT,
    ADD COLUMN "summary" TEXT;
