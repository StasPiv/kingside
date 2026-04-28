-- KS-2095: локализация курсов.
-- Поля `lang` + `parent_course_id` на Course / `parent_lesson_id` на Lesson.
-- Backfill: все существующие курсы/уроки получают lang='ru' (default),
-- parent IDs = NULL (становятся root). Дальше через `--lang en --parent`
-- импортёр заливает английские варианты, привязанные к русским parent'ам.

-- ─── Course ──────────────────────────────────────────────────────────

ALTER TABLE "courses"
  ADD COLUMN "lang" TEXT NOT NULL DEFAULT 'ru',
  ADD COLUMN "parent_course_id" UUID;

-- Снимаем старую глобальную уникальность slug — slug теперь уникален в
-- паре с lang (один курс может иметь ru/en варианты с одинаковым slug).
DROP INDEX IF EXISTS "courses_slug_key";

CREATE UNIQUE INDEX "courses_slug_lang_key"
  ON "courses" ("slug", "lang");

-- KS-2095: один lang на parent. PostgreSQL UNIQUE с NULL trips каждый
-- NULL distinct → root-курсы (parent_course_id IS NULL) с одинаковым
-- lang НЕ конфликтуют. Уникальность работает только когда parent
-- IS NOT NULL — это и нужно семантически.
CREATE UNIQUE INDEX "courses_parent_course_id_lang_key"
  ON "courses" ("parent_course_id", "lang");

CREATE INDEX "courses_lang_is_published_idx"
  ON "courses" ("lang", "is_published");

ALTER TABLE "courses"
  ADD CONSTRAINT "courses_parent_course_id_fkey"
  FOREIGN KEY ("parent_course_id") REFERENCES "courses"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Lesson ──────────────────────────────────────────────────────────

ALTER TABLE "lessons"
  ADD COLUMN "lang" TEXT NOT NULL DEFAULT 'ru',
  ADD COLUMN "parent_lesson_id" UUID;

CREATE INDEX "lessons_parent_lesson_id_idx"
  ON "lessons" ("parent_lesson_id");

ALTER TABLE "lessons"
  ADD CONSTRAINT "lessons_parent_lesson_id_fkey"
  FOREIGN KEY ("parent_lesson_id") REFERENCES "lessons"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
