/**
 * KS-2649 / ADR-054 Phase E3 — integration verification.
 *
 * Проверяет, что:
 *   1. Legacy таблицы `user_*` дропнуты.
 *   2. CHECK constraint'ы установлены.
 *   3. Полный CRUD пользовательского курса через User*Service работает
 *      на единых таблицах (как в Phase E2 verify, но без отсылки к
 *      legacy таблицам).
 *
 * Запуск:
 *   DATABASE_URL=... node apps/api/dist/scripts/verify-adr054-phase-e3.js
 */

/* eslint-disable no-console */
import { PrismaClient } from '@kingside/db';
import { UserCoursesService } from '../lessons/user-courses/user-courses.service';
import { UserLessonsService } from '../lessons/user-courses/user-lessons.service';
import { UserProgressService } from '../lessons/user-courses/user-progress.service';
import { SlugService } from '../lessons/user-courses/slug.service';
import type { CacheService } from '../common/cache.service';
import type { PrismaService } from '../prisma/prisma.service';

const TAG = `ks2649-${Date.now()}`;
const ownerId = '11111111-1111-4111-a111-dddd00000001';

interface TableExistsRow {
  exists: boolean;
}

interface ConstraintRow {
  conname: string;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const prismaSvc = prisma as unknown as PrismaService;
  const cache: CacheService = {
    getOrSet: (_k: string, _ttl: number, fn: () => unknown) => fn(),
    invalidate: async () => undefined,
  } as unknown as CacheService;

  const slug = new SlugService(prismaSvc);
  const userCoursesSvc = new UserCoursesService(prismaSvc, slug, cache);
  const userLessonsSvc = new UserLessonsService(prismaSvc);
  const userProgressSvc = new UserProgressService(prismaSvc);

  let anyFailure = false;
  const fail = (msg: string) => {
    anyFailure = true;
    console.log(`FAIL: ${msg}`);
  };
  const ok = (msg: string) => console.log(`OK:   ${msg}`);

  let courseId: string | null = null;
  let lessonId: string | null = null;
  let stepId: string | null = null;

  try {
    // ── 1. Legacy таблицы дропнуты ─────────────────────────────────
    for (const tbl of [
      'user_courses',
      'user_lessons',
      'user_lesson_steps',
      'user_course_play_progress',
      'user_lesson_play_progress',
    ]) {
      const r = await prisma.$queryRawUnsafe<TableExistsRow[]>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
            WHERE table_schema='public' AND table_name=$1
         ) AS exists`,
        tbl,
      );
      if (r[0]?.exists) fail(`legacy table ${tbl} STILL EXISTS`);
      else ok(`dropped: ${tbl}`);
    }

    // ── 2. CHECK constraints на месте ──────────────────────────────
    const cons = await prisma.$queryRaw<ConstraintRow[]>`
      SELECT conname FROM pg_constraint
       WHERE conname IN ('courses_visibility_owner_check', 'lessons_published_user_check')
    `;
    const conNames = new Set(cons.map((c) => c.conname));
    if (conNames.has('courses_visibility_owner_check'))
      ok('CHECK: courses_visibility_owner_check');
    else fail('CHECK: courses_visibility_owner_check missing');
    if (conNames.has('lessons_published_user_check'))
      ok('CHECK: lessons_published_user_check');
    else fail('CHECK: lessons_published_user_check missing');

    // ── 3. CHECK enforced: пользовательский курс с is_published=true → fail ─
    await prisma.user.upsert({
      where: { id: ownerId },
      update: {},
      create: { id: ownerId, username: `${TAG}-owner` },
    });

    let checkRejected = false;
    try {
      await prisma.course.create({
        data: {
          ownerId,
          slug: `${TAG}-bad`,
          lang: 'ru',
          title: 'bad',
          isPublished: true, // должно нарушить courses_visibility_owner_check
        },
      });
    } catch (e) {
      checkRejected = true;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('courses_visibility_owner_check'))
        ok('CHECK rejects user-owned course with is_published=true');
      else fail(`CHECK rejected with unexpected message: ${msg}`);
    }
    if (!checkRejected)
      fail('CHECK courses_visibility_owner_check not enforced');

    // ── 4. Happy path: User*Service на единых таблицах ─────────────
    const created = await userCoursesSvc.create(ownerId, {
      title: `${TAG}-course`,
    });
    courseId = created.id;
    if (created.ownerId !== ownerId) fail(`create.ownerId mismatch`);
    else ok(`create: course ${courseId}`);

    const lesson = await userCoursesSvc.addLesson(ownerId, courseId, {
      title: `${TAG}-lesson`,
      estMinutes: 5,
    });
    lessonId = lesson.id;
    ok(`addLesson: ${lessonId}`);

    const step = await userLessonsSvc.addStep(lessonId, {
      type: 'text',
      payload: { html: 'hi' } as any,
    });
    stepId = step.id;
    ok(`addStep: ${stepId}`);

    await userProgressSvc.updateStepProgress(ownerId, lessonId, stepId, 'done');
    await userProgressSvc.completeLesson(ownerId, lessonId, 1.0);
    const courseProg = await prisma.userCourseProgress.findUnique({
      where: { userId_courseId: { userId: ownerId, courseId } },
    });
    if (!courseProg?.completedAt) fail('course not auto-completed');
    else ok(`course auto-completed at ${courseProg.completedAt.toISOString()}`);

    const fullCourse = await userCoursesSvc.getBySlug(ownerId, created.slug);
    if (fullCourse.progress?.completedLessonsCount !== 1)
      fail(`completedLessonsCount=${fullCourse.progress?.completedLessonsCount}`);
    else ok('getBySlug: completedLessonsCount=1');

    await userCoursesSvc.delete(ownerId, courseId);
    const after = await prisma.course.findUnique({ where: { id: courseId } });
    if (after) fail('delete: course still exists');
    else ok('delete: cascade');
  } finally {
    if (courseId)
      await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
  }

  if (anyFailure) {
    console.log('\nVERIFY FAILED');
    process.exit(1);
  }
  console.log('\nVERIFY OK');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
