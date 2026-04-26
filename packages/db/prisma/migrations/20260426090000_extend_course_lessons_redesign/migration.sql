-- KS-1933 (Lessons-redesign B1): расширение модели Course.
-- См. docs/architecture/KS-1931-lessons-redesign-concept.md §8.1.
-- Все новые поля nullable либо имеют дефолт — обратная совместимость
-- сохраняется, существующие курсы не ломаются.

ALTER TABLE "courses"
    ADD COLUMN "cover_url"          TEXT,
    ADD COLUMN "difficulty"         INTEGER  NOT NULL DEFAULT 2,
    ADD COLUMN "estimated_minutes"  INTEGER,
    ADD COLUMN "audience_i18n_key"  TEXT,
    ADD COLUMN "hook_i18n_key"      TEXT,
    ADD COLUMN "outcome_i18n_key"   TEXT,
    ADD COLUMN "tags"               TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[];
