-- KS-2639 / ADR-054 §3 Phase A.
--
-- Additive-расширение системных таблиц для подготовки к слиянию
-- пользовательских курсов (`user_courses` / `user_lessons` /
-- `user_lesson_steps`) в системные. Старые таблицы в Phase A не
-- трогаются — их удаление и копирование данных запланированы в
-- Phase B/E.
--
-- Изменения:
--   * `courses.owner_id` (FK → `users.id`, ON DELETE CASCADE) —
--     владелец авторского курса. NULL = системный курс.
--   * `courses.is_public` (BOOLEAN, default false) — публичный флаг
--     для авторских курсов. У системных всегда FALSE.
--   * `lessons.owner_id` / `lesson_steps.owner_id` — денормализация
--     `Course.ownerId`, без FK; целостность через `course_id` chain.
--   * Slug-namespace через partial-unique. Старый
--     `courses_slug_lang_key` снят и заменён на
--     `courses_slug_lang_system_uniq` (`WHERE owner_id IS NULL`) —
--     поведение для системных курсов идентично прежнему. Для
--     авторских — отдельный namespace `(owner_id, slug)`.
--   * Индексы под listing'и: `courses (owner_id, updated_at)`,
--     `lessons (owner_id, course_id)`.
--
-- ADD COLUMN с DEFAULT BOOLEAN — Postgres 11+ выполняет как метаданные
-- таблицы (без переписи строк), миграция безопасна на больших данных.
-- Все новые поля nullable / default false → существующие системные
-- записи не задеты.
--
-- CHECK constraint на взаимоисключение `is_published` (system) vs
-- `is_public` (user) намеренно НЕ добавляем в Phase A — он попадёт в
-- Phase E (см. ADR-054 §3.3 и §6) после удаления старых таблиц, чтобы
-- не ломать промежуточные write'ы dual-write фазы.
--
-- IF NOT EXISTS — идемпотентность для повторного запуска.

-- 1. Колонки.
ALTER TABLE "courses"
  ADD COLUMN IF NOT EXISTS "owner_id"  UUID,
  ADD COLUMN IF NOT EXISTS "is_public" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "lessons"
  ADD COLUMN IF NOT EXISTS "owner_id" UUID;

ALTER TABLE "lesson_steps"
  ADD COLUMN IF NOT EXISTS "owner_id" UUID;

-- 2. FK на User для Course.ownerId. У Lesson/LessonStep FK сознательно
--    нет — целостность через `lesson.course_id → courses.owner_id`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'courses_owner_id_fkey'
  ) THEN
    ALTER TABLE "courses"
      ADD CONSTRAINT "courses_owner_id_fkey"
      FOREIGN KEY ("owner_id") REFERENCES "users"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END
$$;

-- 3. Slug-namespace.
DROP INDEX IF EXISTS "courses_slug_lang_key";
CREATE UNIQUE INDEX IF NOT EXISTS "courses_slug_lang_system_uniq"
  ON "courses" ("slug", "lang")
  WHERE "owner_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "courses_owner_slug_user_uniq"
  ON "courses" ("owner_id", "slug")
  WHERE "owner_id" IS NOT NULL;

-- 4. Listing-индексы.
CREATE INDEX IF NOT EXISTS "courses_owner_id_updated_at_idx"
  ON "courses" ("owner_id", "updated_at");
CREATE INDEX IF NOT EXISTS "lessons_owner_id_course_id_idx"
  ON "lessons" ("owner_id", "course_id");
