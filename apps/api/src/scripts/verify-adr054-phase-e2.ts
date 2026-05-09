/**
 * KS-2648 / ADR-054 Phase E2. Integration verification переключения
 * `User*Service` на единые таблицы.
 *
 * Сценарий:
 *   1. setup: создаём тестового пользователя.
 *   2. UserCoursesService.create — должен записать в `courses`
 *      (`ownerId !== null`).
 *   3. UserCoursesService.list({mine:true}) — возвращает свежий курс.
 *   4. UserCoursesService.addLesson — записывает в `lessons` с
 *      денормализованным `ownerId`.
 *   5. UserLessonsService.addStep — записывает в `lesson_steps` с
 *      денормализованным `ownerId`.
 *   6. UserProgressService.updateStepProgress — пишет в
 *      `user_lesson_progress` (системная таблица).
 *   7. UserProgressService.completeLesson — `completedAt` ставится в
 *      `user_lesson_progress` И в `user_course_progress` (если все
 *      уроки курса завершены).
 *   8. UserCoursesService.getBySlug — возвращает курс с lessons и
 *      progress.
 *   9. UserCoursesService.delete — каскадно удаляет lessons/steps/
 *      progress.
 *   10. cleanup: тестовый пользователь.
 *
 * Запуск:
 *   DATABASE_URL=... node apps/api/dist/scripts/verify-adr054-phase-e2.js
 */

/* eslint-disable no-console */
import { PrismaClient } from '@kingside/db';
import { UserCoursesService } from '../lessons/user-courses/user-courses.service';
import { UserLessonsService } from '../lessons/user-courses/user-lessons.service';
import { UserProgressService } from '../lessons/user-courses/user-progress.service';
import { SlugService } from '../lessons/user-courses/slug.service';
import type { CacheService } from '../common/cache.service';
import type { PrismaService } from '../prisma/prisma.service';

const TAG = `ks2648-${Date.now()}`;
const ownerId = '11111111-1111-4111-a111-cccc00000001';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const prismaSvc = prisma as unknown as PrismaService;

  // Cache stub: getOrSet просто вызывает fn, invalidate no-op.
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
    // setup
    await prisma.user.upsert({
      where: { id: ownerId },
      update: {},
      create: { id: ownerId, username: `${TAG}-owner` },
    });

    // 1. create user-course
    const created = await userCoursesSvc.create(ownerId, {
      title: `${TAG}-course`,
      description: 'phase E2 test',
    });
    courseId = created.id;
    if (created.ownerId !== ownerId) fail(`create.ownerId mismatch: ${created.ownerId}`);
    else ok(`create: course ${courseId} ownerId=${ownerId}`);

    // 2. list mine
    const list = await userCoursesSvc.list(ownerId, { mine: true });
    const found = list.data.find((c) => c.id === courseId);
    if (!found) fail('list({mine:true}): course not found');
    else ok(`list({mine:true}): found ${courseId}`);

    // 3. addLesson
    const lesson = await userCoursesSvc.addLesson(ownerId, courseId, {
      title: `${TAG}-lesson`,
      estMinutes: 5,
    });
    lessonId = lesson.id;
    // Lesson в едидной таблице — проверим напрямую
    const lessonRow = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { courseId: true, ownerId: true, title: true },
    });
    if (!lessonRow) fail('addLesson: row not found in `lessons`');
    else if (lessonRow.ownerId !== ownerId)
      fail(`addLesson.ownerId mismatch: ${lessonRow.ownerId}`);
    else if (lessonRow.courseId !== courseId)
      fail(`addLesson.courseId mismatch: ${lessonRow.courseId}`);
    else ok(`addLesson: lesson ${lessonId} → courses table`);

    // 4. addStep (через UserLessonsService)
    const step = await userLessonsSvc.addStep(lessonId, {
      type: 'text',
      // KS-2648: текстовый payload — `html` поле в StepPayload union'е
      // у text-варианта не задекларировано как top-level; кастуем
      // через as any (verify-skript, не runtime).
      payload: { html: 'hello' } as any,
    });
    stepId = step.id;
    const stepRow = await prisma.lessonStep.findUnique({
      where: { id: stepId },
      select: { lessonId: true, ownerId: true, type: true },
    });
    if (!stepRow) fail('addStep: row not found in `lesson_steps`');
    else if (stepRow.ownerId !== ownerId)
      fail(`addStep.ownerId mismatch: ${stepRow.ownerId}`);
    else if (stepRow.lessonId !== lessonId)
      fail(`addStep.lessonId mismatch: ${stepRow.lessonId}`);
    else ok(`addStep: step ${stepId} → lesson_steps table`);

    // 5. updateStepProgress
    await userProgressSvc.updateStepProgress(ownerId, lessonId, stepId, 'done');
    const lessonProgress = await prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId: ownerId, lessonId } },
    });
    if (!lessonProgress)
      fail('updateStepProgress: row not found in `user_lesson_progress`');
    else {
      const ss = lessonProgress.stepsState as Record<string, string> | null;
      if (ss?.[stepId] !== 'done')
        fail(`updateStepProgress.stepsState mismatch: ${JSON.stringify(ss)}`);
      else ok(`updateStepProgress: step done → user_lesson_progress`);
    }

    // 6. completeLesson — порог должен сработать (1 шаг, 1 done = 100%)
    await userProgressSvc.completeLesson(ownerId, lessonId, 1.0);
    const completed = await prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId: ownerId, lessonId } },
    });
    if (!completed?.completedAt) fail('completeLesson: completedAt not set');
    else ok(`completeLesson: completedAt=${completed.completedAt.toISOString()}`);

    const courseProgress = await prisma.userCourseProgress.findUnique({
      where: { userId_courseId: { userId: ownerId, courseId } },
    });
    if (!courseProgress?.completedAt)
      fail('completeLesson: courseProgress.completedAt not set (expected since 1/1 lessons done)');
    else
      ok(
        `course completed: courseProgress.completedAt=${courseProgress.completedAt.toISOString()}`,
      );

    // 7. getBySlug
    const fullCourse = await userCoursesSvc.getBySlug(ownerId, created.slug);
    if (fullCourse.lessons.length !== 1)
      fail(`getBySlug.lessons.length=${fullCourse.lessons.length}`);
    else if (fullCourse.progress?.completedLessonsCount !== 1)
      fail(`getBySlug.progress.completedLessonsCount=${fullCourse.progress?.completedLessonsCount}`);
    else ok(`getBySlug: course + 1 lesson + completedLessonsCount=1`);

    // 8. delete cascade
    await userCoursesSvc.delete(ownerId, courseId);
    const afterDel = await prisma.course.findUnique({ where: { id: courseId } });
    const lessonAfter = await prisma.lesson.findUnique({
      where: { id: lessonId },
    });
    const stepAfter = await prisma.lessonStep.findUnique({
      where: { id: stepId },
    });
    if (afterDel) fail('delete: course still exists');
    else if (lessonAfter) fail('delete: lesson not cascaded');
    else if (stepAfter) fail('delete: step not cascaded');
    else ok('delete: cascade course → lesson → step');
  } finally {
    if (courseId) {
      await prisma.course.deleteMany({ where: { id: courseId } });
    }
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
