/**
 * KS-2640 / ADR-054 §4 Phase B. Копирование пользовательских курсов
 * (`user_courses` / `user_lessons` / `user_lesson_steps`) в системные
 * таблицы `courses` / `lessons` / `lesson_steps`.
 *
 * Семантика:
 *   * id'ы сохраняются 1:1 — это критично для последующего шага
 *     `copy-progress`, у которого `user_lesson_play_progress.user_lesson_id
 *     === lessons.id` после копирования.
 *   * `lessons.owner_id` / `lesson_steps.owner_id` денормализуются из
 *     `user_courses.owner_id` (через JOIN).
 *   * `lang` у пользовательских заполняем фиксированным `'ru'` (KS-2640
 *     не вводит пользовательскую локаль; локаль автора будет в Phase C).
 *   * `is_public` копируется из `user_courses.is_public`.
 *   * Системные курсы (`courses.owner_id IS NULL`) не задеваются.
 *
 * Идемпотентность:
 *   * Все три INSERT'а используют `ON CONFLICT (id) DO NOTHING` —
 *     повторный запуск не дублирует и не падает.
 *   * Для `lessons` отдельно DO NOTHING при коллизии `(course_id, slug)`
 *     не нужен: пользовательские lesson'ы пишутся со `slug = NULL`,
 *     а partial-uniqueness не нарушается.
 *
 * Запуск (dev/prod):
 *   DATABASE_URL=... node apps/api/dist/scripts/adr054-phase-b-copy-courses.js
 *
 * В prod выполняется через ECS run-task аналогично KS-2616 (см.
 * комментарий задачи KS-2640).
 */

import { PrismaClient } from '@kingside/db';

interface CountRow {
  c: bigint;
}

async function count(prisma: PrismaClient, sql: string, ...params: unknown[]): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(sql, ...params);
  return Number(rows[0]?.c ?? 0n);
}

export interface CopyContentResult {
  before: { coursesUserOwned: number; lessonsUserOwned: number; lessonStepsUserOwned: number };
  after: { coursesUserOwned: number; lessonsUserOwned: number; lessonStepsUserOwned: number };
  source: { userCourses: number; userLessons: number; userLessonSteps: number };
  inserted: { courses: number; lessons: number; lessonSteps: number };
}

export async function copyUserContent(prisma: PrismaClient): Promise<CopyContentResult> {
  // ── Snapshot до копирования ──────────────────────────────────────
  const before = {
    coursesUserOwned: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM courses WHERE owner_id IS NOT NULL`,
    ),
    lessonsUserOwned: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM lessons WHERE owner_id IS NOT NULL`,
    ),
    lessonStepsUserOwned: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM lesson_steps WHERE owner_id IS NOT NULL`,
    ),
  };

  const source = {
    userCourses: await count(prisma, `SELECT COUNT(*)::int AS c FROM user_courses`),
    userLessons: await count(prisma, `SELECT COUNT(*)::int AS c FROM user_lessons`),
    userLessonSteps: await count(prisma, `SELECT COUNT(*)::int AS c FROM user_lesson_steps`),
  };

  // ── 1. user_courses → courses ────────────────────────────────────
  // INSERT...SELECT: id, owner_id, slug, lang='ru', title, description,
  // is_public, created_at, updated_at. Поля системных (level, title_key,
  // description_key, difficulty, *_i18n_key, tags, block_order, order,
  // cover_url, estimated_minutes, audience/hook/outcome) остаются NULL
  // / default — миграция Phase B сделала это допустимым.
  const inserted = { courses: 0, lessons: 0, lessonSteps: 0 };

  inserted.courses = await prisma.$executeRawUnsafe(`
    INSERT INTO courses (
      id, owner_id, slug, lang,
      title, description, is_public,
      created_at, updated_at
    )
    SELECT
      uc.id, uc.owner_id, uc.slug, 'ru',
      uc.title, uc.description, uc.is_public,
      uc.created_at, uc.updated_at
    FROM user_courses uc
    ON CONFLICT (id) DO NOTHING
  `);

  // ── 2. user_lessons → lessons ────────────────────────────────────
  // owner_id денормализуется из user_courses через JOIN. lang='ru'
  // (фиксированный для пользовательских в Phase B).
  inserted.lessons = await prisma.$executeRawUnsafe(`
    INSERT INTO lessons (
      id, course_id, owner_id,
      "order", title, est_minutes, lang,
      created_at, updated_at
    )
    SELECT
      ul.id, ul.user_course_id, uc.owner_id,
      ul."order", ul.title, COALESCE(ul.est_minutes, 10), 'ru',
      ul.created_at, ul.updated_at
    FROM user_lessons ul
    JOIN user_courses uc ON uc.id = ul.user_course_id
    ON CONFLICT (id) DO NOTHING
  `);

  // ── 3. user_lesson_steps → lesson_steps ──────────────────────────
  inserted.lessonSteps = await prisma.$executeRawUnsafe(`
    INSERT INTO lesson_steps (
      id, lesson_id, owner_id,
      "order", type, payload, created_at
    )
    SELECT
      uls.id, uls.user_lesson_id, uc.owner_id,
      uls."order", uls.type, uls.payload, uls.created_at
    FROM user_lesson_steps uls
    JOIN user_lessons ul ON ul.id = uls.user_lesson_id
    JOIN user_courses uc ON uc.id = ul.user_course_id
    ON CONFLICT (id) DO NOTHING
  `);

  // ── Snapshot после ───────────────────────────────────────────────
  const after = {
    coursesUserOwned: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM courses WHERE owner_id IS NOT NULL`,
    ),
    lessonsUserOwned: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM lessons WHERE owner_id IS NOT NULL`,
    ),
    lessonStepsUserOwned: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM lesson_steps WHERE owner_id IS NOT NULL`,
    ),
  };

  return { before, after, source, inserted };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    process.stdout.write('[adr054-phase-b-copy-courses] start\n');
    const r = await copyUserContent(prisma);
    process.stdout.write(`source counts:           ${JSON.stringify(r.source)}\n`);
    process.stdout.write(`before user-owned counts: ${JSON.stringify(r.before)}\n`);
    process.stdout.write(`inserted counts:          ${JSON.stringify(r.inserted)}\n`);
    process.stdout.write(`after user-owned counts:  ${JSON.stringify(r.after)}\n`);

    // Verification: после копирования в основной таблице должно быть
    // не меньше user-owned записей, чем в источнике (с учётом возможных
    // прежних запусков).
    const okCourses = r.after.coursesUserOwned >= r.source.userCourses;
    const okLessons = r.after.lessonsUserOwned >= r.source.userLessons;
    const okSteps = r.after.lessonStepsUserOwned >= r.source.userLessonSteps;
    if (okCourses && okLessons && okSteps) {
      process.stdout.write('VERIFY OK\n');
    } else {
      process.stderr.write(
        `VERIFY FAILED: courses=${okCourses} lessons=${okLessons} steps=${okSteps}\n`,
      );
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
