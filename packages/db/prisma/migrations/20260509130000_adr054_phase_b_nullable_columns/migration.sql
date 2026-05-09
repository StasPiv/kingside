-- KS-2640 / ADR-054 §4 Phase B.
--
-- Готовим схему `courses` / `lessons` к копированию пользовательских
-- курсов. Поля, которые есть только у системных (`level`, `title_key`,
-- `description_key`, `difficulty` в `courses`; `slug`, `block_key`,
-- `kind`, `title_key`, `summary_key` в `lessons`), делаем NULLable —
-- иначе INSERT...SELECT из `user_courses`/`user_lessons` упадёт с
-- NOT NULL violation.
--
-- ALTER COLUMN ... DROP NOT NULL — метаданные таблицы, без переписи
-- строк (Postgres 11+). Существующие системные записи остаются
-- заполненными, поведение не меняется.
--
-- Идемпотентно через DO-блоки: повторный запуск ничего не ломает.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'level' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "courses" ALTER COLUMN "level" DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'title_key' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "courses" ALTER COLUMN "title_key" DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'description_key' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "courses" ALTER COLUMN "description_key" DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'difficulty' AND is_nullable = 'NO'
  ) THEN
    -- Снимаем DEFAULT тоже, чтобы пользовательские строки не получали 2.
    ALTER TABLE "courses" ALTER COLUMN "difficulty" DROP DEFAULT;
    ALTER TABLE "courses" ALTER COLUMN "difficulty" DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lessons' AND column_name = 'slug' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "lessons" ALTER COLUMN "slug" DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lessons' AND column_name = 'block_key' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "lessons" ALTER COLUMN "block_key" DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lessons' AND column_name = 'kind' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "lessons" ALTER COLUMN "kind" DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lessons' AND column_name = 'title_key' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "lessons" ALTER COLUMN "title_key" DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lessons' AND column_name = 'summary_key' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "lessons" ALTER COLUMN "summary_key" DROP NOT NULL;
  END IF;
END
$$;
