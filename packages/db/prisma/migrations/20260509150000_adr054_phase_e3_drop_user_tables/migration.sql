-- KS-2649 / ADR-054 §4 Phase E3 — финальный cleanup.
--
-- DROP таблиц `user_*` после переключения сервисов на единые таблицы
-- (Phase E2, KS-2648). Перед drop'ом: на проде в `user_courses` после
-- KS-2641 prod-copy-скрипта оставался 1 курс, эти данные уже
-- скопированы в `courses`/`lessons`/`lesson_steps`, дамп пропускаем
-- по решению координатора (KS-2649 ACK).
--
-- Каскад FK гарантирует чистое удаление: `user_lesson_play_progress`
-- → `user_lesson_steps` → `user_lessons` → `user_courses` →
-- `user_course_play_progress`. Drop делаем строго в этом порядке
-- (сначала зависимые), но `IF EXISTS` страхует — если таблицы
-- уже дропнуты вручную, миграция остаётся идемпотентной.
--
-- CHECK constraint на `courses` и `lessons` — закрепляет инвариант
-- ADR-054 §3.3 (взаимоисключение `is_published` системного и
-- `is_public` пользовательского). Перед его установкой убеждаемся,
-- что ни одна существующая строка его не нарушает (один SELECT).
-- Если нарушает — явно говорим в `RAISE`, чтобы прокси-уровень
-- увидел проблему и не дропнул таблицы.

-- ── 1. Sanity-check: нет конфликтующих строк в courses/lessons ──────
DO $$
DECLARE
  bad_courses INT;
  bad_lessons INT;
BEGIN
  SELECT COUNT(*) INTO bad_courses
    FROM courses
   WHERE NOT (
     (owner_id IS NULL AND is_public = false)
     OR (owner_id IS NOT NULL AND is_published = false)
   );
  IF bad_courses > 0 THEN
    RAISE EXCEPTION
      'KS-2649: % courses violate visibility/owner invariant — fix before E3 migration',
      bad_courses;
  END IF;

  SELECT COUNT(*) INTO bad_lessons
    FROM lessons
   WHERE owner_id IS NOT NULL AND is_published = true;
  IF bad_lessons > 0 THEN
    RAISE EXCEPTION
      'KS-2649: % user-owned lessons have is_published=true — fix before E3 migration',
      bad_lessons;
  END IF;
END
$$;

-- ── 2. DROP user_* таблиц ────────────────────────────────────────────
DROP TABLE IF EXISTS "user_lesson_play_progress";
DROP TABLE IF EXISTS "user_course_play_progress";
DROP TABLE IF EXISTS "user_lesson_steps";
DROP TABLE IF EXISTS "user_lessons";
DROP TABLE IF EXISTS "user_courses";

-- ── 3. CHECK constraints ─────────────────────────────────────────────
-- `courses_visibility_owner_check`:
--   * системный (owner_id IS NULL) → is_public должен быть false;
--   * пользовательский (owner_id IS NOT NULL) → is_published должен
--     быть false (это поле — флаг публикации админом для системных,
--     для пользовательских всегда false).
ALTER TABLE "courses"
  DROP CONSTRAINT IF EXISTS "courses_visibility_owner_check";
ALTER TABLE "courses"
  ADD CONSTRAINT "courses_visibility_owner_check"
  CHECK (
    (owner_id IS NULL AND is_public = false)
    OR (owner_id IS NOT NULL AND is_published = false)
  );

-- `lessons_published_user_check`:
--   * пользовательский урок (owner_id IS NOT NULL) → is_published
--     должен быть false. Системные уроки могут иметь любой is_published.
ALTER TABLE "lessons"
  DROP CONSTRAINT IF EXISTS "lessons_published_user_check";
ALTER TABLE "lessons"
  ADD CONSTRAINT "lessons_published_user_check"
  CHECK (owner_id IS NULL OR is_published = false);
