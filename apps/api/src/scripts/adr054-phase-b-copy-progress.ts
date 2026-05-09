/**
 * KS-2640 / ADR-054 §4 Phase B. Копирование пользовательского
 * прогресса (`user_course_play_progress` / `user_lesson_play_progress`)
 * в системные таблицы прогресса (`user_course_progress` /
 * `user_lesson_progress`). После Phase E эти системные таблицы
 * переименуются в `course_progress` / `lesson_progress` (см. ADR §3.2).
 *
 * Mapping:
 *   user_course_play_progress → user_course_progress
 *     user_id          → user_id
 *     user_course_id   → course_id   (id'ы курсов 1:1, см. copy-courses)
 *     started_at       → started_at
 *     completed_at     → completed_at
 *     last_activity_at → updated_at  (системный аналог timestamp'а)
 *     -- current_lesson_id у пользовательского нет → NULL.
 *     -- completed_lessons_count не сохраняем (не нужно, считаем on-demand).
 *
 *   user_lesson_play_progress → user_lesson_progress
 *     user_id          → user_id
 *     user_lesson_id   → lesson_id   (id'ы уроков 1:1)
 *     started_at       → started_at
 *     completed_at     → completed_at
 *     steps_state      → steps_state
 *     last_activity_at → updated_at
 *     -- score у пользовательского нет → 0.
 *     -- mastered_at у пользовательского нет → NULL.
 *
 * Идемпотентность: ON CONFLICT (user_id, course_id) / (user_id,
 * lesson_id) DO NOTHING. Повторный запуск ничего не дублирует.
 *
 * Системный прогресс (по системным курсам) не задеваем — пишем только
 * по тем `course_id` / `lesson_id`, которые относятся к user-owned
 * (после Phase B copy-courses у них `owner_id IS NOT NULL`).
 *
 * Запуск:
 *   DATABASE_URL=... node apps/api/dist/scripts/adr054-phase-b-copy-progress.js
 */

import { PrismaClient } from '@kingside/db';

interface CountRow {
  c: bigint;
}

async function count(prisma: PrismaClient, sql: string, ...params: unknown[]): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(sql, ...params);
  return Number(rows[0]?.c ?? 0n);
}

export interface CopyProgressResult {
  source: { userCoursePlay: number; userLessonPlay: number };
  before: {
    courseProgressSystem: number;
    courseProgressUserOwned: number;
    lessonProgressSystem: number;
    lessonProgressUserOwned: number;
  };
  after: {
    courseProgressSystem: number;
    courseProgressUserOwned: number;
    lessonProgressSystem: number;
    lessonProgressUserOwned: number;
  };
  inserted: { courseProgress: number; lessonProgress: number };
}

export async function copyUserProgress(prisma: PrismaClient): Promise<CopyProgressResult> {
  const before = {
    courseProgressSystem: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM user_course_progress ucp
         JOIN courses c ON c.id = ucp.course_id
        WHERE c.owner_id IS NULL`,
    ),
    courseProgressUserOwned: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM user_course_progress ucp
         JOIN courses c ON c.id = ucp.course_id
        WHERE c.owner_id IS NOT NULL`,
    ),
    lessonProgressSystem: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM user_lesson_progress ulp
         JOIN lessons l ON l.id = ulp.lesson_id
        WHERE l.owner_id IS NULL`,
    ),
    lessonProgressUserOwned: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM user_lesson_progress ulp
         JOIN lessons l ON l.id = ulp.lesson_id
        WHERE l.owner_id IS NOT NULL`,
    ),
  };

  const source = {
    userCoursePlay: await count(prisma, `SELECT COUNT(*)::int AS c FROM user_course_play_progress`),
    userLessonPlay: await count(prisma, `SELECT COUNT(*)::int AS c FROM user_lesson_play_progress`),
  };

  // ── 1. user_course_play_progress → user_course_progress ───────────
  // Берём только те строки, где соответствующий `user_course_id` уже
  // скопирован в `courses` (после copy-courses). Это дополнительная
  // защита: если порядок запуска нарушен, FK на courses не падает —
  // строка просто не копируется и попадёт в следующий прогон.
  const insertedCourseProgress = await prisma.$executeRawUnsafe(`
    INSERT INTO user_course_progress (
      id, user_id, course_id, started_at, completed_at, current_lesson_id, updated_at
    )
    SELECT
      ucpp.id, ucpp.user_id, ucpp.user_course_id,
      ucpp.started_at, ucpp.completed_at, NULL,
      ucpp.last_activity_at
    FROM user_course_play_progress ucpp
    JOIN courses c ON c.id = ucpp.user_course_id AND c.owner_id IS NOT NULL
    ON CONFLICT (user_id, course_id) DO NOTHING
  `);

  // ── 2. user_lesson_play_progress → user_lesson_progress ───────────
  // Аналогично: JOIN на lessons (user-owned), чтобы исключить
  // несинхронизированные строки.
  //
  // `score` ставим 0 (системное поле, у user_play отсутствует).
  // `mastered_at` — NULL (SM-2 для пользовательских уроков не
  // запускается до отдельного решения — см. ADR §3.2 п.7).
  const insertedLessonProgress = await prisma.$executeRawUnsafe(`
    INSERT INTO user_lesson_progress (
      id, user_id, lesson_id, started_at, completed_at, mastered_at,
      score, steps_state, updated_at
    )
    SELECT
      ulpp.id, ulpp.user_id, ulpp.user_lesson_id,
      ulpp.started_at, ulpp.completed_at, NULL,
      0, ulpp.steps_state,
      ulpp.last_activity_at
    FROM user_lesson_play_progress ulpp
    JOIN lessons l ON l.id = ulpp.user_lesson_id AND l.owner_id IS NOT NULL
    ON CONFLICT (user_id, lesson_id) DO NOTHING
  `);

  const after = {
    courseProgressSystem: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM user_course_progress ucp
         JOIN courses c ON c.id = ucp.course_id
        WHERE c.owner_id IS NULL`,
    ),
    courseProgressUserOwned: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM user_course_progress ucp
         JOIN courses c ON c.id = ucp.course_id
        WHERE c.owner_id IS NOT NULL`,
    ),
    lessonProgressSystem: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM user_lesson_progress ulp
         JOIN lessons l ON l.id = ulp.lesson_id
        WHERE l.owner_id IS NULL`,
    ),
    lessonProgressUserOwned: await count(
      prisma,
      `SELECT COUNT(*)::int AS c FROM user_lesson_progress ulp
         JOIN lessons l ON l.id = ulp.lesson_id
        WHERE l.owner_id IS NOT NULL`,
    ),
  };

  return {
    source,
    before,
    after,
    inserted: {
      courseProgress: insertedCourseProgress,
      lessonProgress: insertedLessonProgress,
    },
  };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    process.stdout.write('[adr054-phase-b-copy-progress] start\n');
    const r = await copyUserProgress(prisma);
    process.stdout.write(`source counts:  ${JSON.stringify(r.source)}\n`);
    process.stdout.write(`before counts:  ${JSON.stringify(r.before)}\n`);
    process.stdout.write(`inserted:       ${JSON.stringify(r.inserted)}\n`);
    process.stdout.write(`after counts:   ${JSON.stringify(r.after)}\n`);

    // Verification:
    //   * системные счётчики не упали (не задеты пользовательским копированием);
    //   * user-owned счётчики после ≥ source (всё скопировано).
    const sysOk =
      r.after.courseProgressSystem === r.before.courseProgressSystem &&
      r.after.lessonProgressSystem === r.before.lessonProgressSystem;
    const userOk =
      r.after.courseProgressUserOwned >= r.source.userCoursePlay &&
      r.after.lessonProgressUserOwned >= r.source.userLessonPlay;
    if (sysOk && userOk) {
      process.stdout.write('VERIFY OK\n');
    } else {
      process.stderr.write(`VERIFY FAILED: sysOk=${sysOk} userOk=${userOk}\n`);
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
