/**
 * KS-2640 / ADR-054 §4 Phase B. Integration verification скриптов
 * `adr054-phase-b-copy-courses.ts` и `adr054-phase-b-copy-progress.ts`
 * на живой БД.
 *
 * Что проверяет:
 *   1. Создаём sample user_course/user_lesson/user_lesson_step +
 *      user_*_play_progress для тестового пользователя.
 *   2. Прогоняем скрипты копирования.
 *   3. Проверяем 13 свойств mirrored записей (id, ownerId, основные
 *      поля, JSON stepsState).
 *   4. Идемпотентность: повторный запуск возвращает inserted=0.
 *   5. Системные счётчики (`courses/lessons/lesson_steps` где
 *      `owner_id IS NULL`) не меняются.
 *   6. Cleanup всех созданных записей в обоих namespace.
 *
 * Запуск (dev/prod-snapshot):
 *   DATABASE_URL=... node apps/api/dist/scripts/verify-adr054-phase-b.js
 */

import { PrismaClient } from '@kingside/db';
import { copyUserContent } from './adr054-phase-b-copy-courses';
import { copyUserProgress } from './adr054-phase-b-copy-progress';

const TAG = `ks2640-${Date.now()}`;
const ownerId = '11111111-1111-4111-a111-bbbb00000001';
const courseId = '22222222-2222-4222-a222-bbbb00000001';
const lessonId = '33333333-3333-4333-a333-bbbb00000001';
const stepId = '44444444-4444-4444-a444-bbbb00000001';

interface CountRow {
  c: bigint;
}

async function setup(prisma: PrismaClient): Promise<void> {
  await prisma.user.upsert({
    where: { id: ownerId },
    update: {},
    create: { id: ownerId, username: `${TAG}-owner` },
  });
  await prisma.userCourse.create({
    data: {
      id: courseId,
      ownerId,
      slug: TAG,
      title: 'Phase B verify course',
      description: 'sample',
      isPublic: false,
    },
  });
  await prisma.userLesson.create({
    data: {
      id: lessonId,
      userCourseId: courseId,
      order: 0,
      title: 'Sample lesson',
      estMinutes: 5,
    },
  });
  await prisma.userLessonStep.create({
    data: {
      id: stepId,
      userLessonId: lessonId,
      order: 0,
      type: 'text',
      payload: { html: 'hello' },
    },
  });
  await prisma.userCoursePlayProgress.create({
    data: {
      userId: ownerId,
      userCourseId: courseId,
      completedLessonsCount: 1,
      startedAt: new Date('2026-05-01T00:00:00Z'),
      lastActivityAt: new Date('2026-05-08T12:00:00Z'),
      completedAt: null,
    },
  });
  await prisma.userLessonPlayProgress.create({
    data: {
      userId: ownerId,
      userLessonId: lessonId,
      completedStepsCount: 1,
      totalSteps: 1,
      stepsState: { [stepId]: 'done' },
      startedAt: new Date('2026-05-01T00:00:00Z'),
      lastActivityAt: new Date('2026-05-08T12:00:00Z'),
      completedAt: new Date('2026-05-08T12:00:00Z'),
    },
  });
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.lessonStep.deleteMany({ where: { id: stepId } });
  await prisma.lesson.deleteMany({ where: { id: lessonId } });
  await prisma.course.deleteMany({ where: { id: courseId } });
  await prisma.userLessonPlayProgress.deleteMany({
    where: { userId: ownerId, userLessonId: lessonId },
  });
  await prisma.userCoursePlayProgress.deleteMany({
    where: { userId: ownerId, userCourseId: courseId },
  });
  await prisma.userLessonStep.deleteMany({ where: { id: stepId } });
  await prisma.userLesson.deleteMany({ where: { id: lessonId } });
  await prisma.userCourse.deleteMany({ where: { id: courseId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let anyFailure = false;
  const fail = (msg: string) => {
    anyFailure = true;
    process.stdout.write(`FAIL: ${msg}\n`);
  };
  const ok = (msg: string) => process.stdout.write(`OK:   ${msg}\n`);

  try {
    const sysBefore = {
      courses: await prisma.course.count({ where: { ownerId: null } }),
      lessons: await prisma.lesson.count({ where: { ownerId: null } }),
      steps: Number(
        (
          await prisma.$queryRawUnsafe<CountRow[]>(
            `SELECT COUNT(*)::int AS c FROM lesson_steps WHERE owner_id IS NULL`,
          )
        )[0]?.c ?? 0n,
      ),
    };

    await setup(prisma);

    const contentRes = await copyUserContent(prisma);
    process.stdout.write(`content: ${JSON.stringify(contentRes.inserted)}\n`);
    const progressRes = await copyUserProgress(prisma);
    process.stdout.write(`progress: ${JSON.stringify(progressRes.inserted)}\n`);

    const c = await prisma.course.findUnique({ where: { id: courseId } });
    const l = await prisma.lesson.findUnique({ where: { id: lessonId } });
    const s = await prisma.lessonStep.findUnique({ where: { id: stepId } });
    const cp = await prisma.userCourseProgress.findUnique({
      where: { userId_courseId: { userId: ownerId, courseId } },
    });
    const lp = await prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId: ownerId, lessonId } },
    });

    const checks: Array<[string, boolean]> = [
      ['course.ownerId === ownerId', c?.ownerId === ownerId],
      ['course.slug', c?.slug === TAG],
      ['course.isPublic === false', c?.isPublic === false],
      ['lesson.ownerId', l?.ownerId === ownerId],
      ['lesson.slug === null', l?.slug === null],
      ['lesson.title === "Sample lesson"', l?.title === 'Sample lesson'],
      ['step.ownerId', s?.ownerId === ownerId],
      ['step.type === "text"', s?.type === 'text'],
      ['course_progress.courseId', cp?.courseId === courseId],
      [
        'course_progress.startedAt = 2026-05-01',
        cp?.startedAt.toISOString().startsWith('2026-05-01') ?? false,
      ],
      ['lesson_progress.lessonId', lp?.lessonId === lessonId],
      ['lesson_progress.score === 0', lp?.score === 0],
      [
        'lesson_progress.stepsState[stepId] === "done"',
        (lp?.stepsState as Record<string, string> | null)?.[stepId] === 'done',
      ],
    ];
    for (const [name, pass] of checks) (pass ? ok : fail)(name);

    const contentRes2 = await copyUserContent(prisma);
    if (
      contentRes2.inserted.courses === 0 &&
      contentRes2.inserted.lessons === 0 &&
      contentRes2.inserted.lessonSteps === 0
    ) {
      ok('idempotent copyUserContent');
    } else {
      fail(`idempotent copyUserContent failed: ${JSON.stringify(contentRes2.inserted)}`);
    }
    const progressRes2 = await copyUserProgress(prisma);
    if (
      progressRes2.inserted.courseProgress === 0 &&
      progressRes2.inserted.lessonProgress === 0
    ) {
      ok('idempotent copyUserProgress');
    } else {
      fail(`idempotent copyUserProgress failed: ${JSON.stringify(progressRes2.inserted)}`);
    }

    const sysAfter = {
      courses: await prisma.course.count({ where: { ownerId: null } }),
      lessons: await prisma.lesson.count({ where: { ownerId: null } }),
      steps: Number(
        (
          await prisma.$queryRawUnsafe<CountRow[]>(
            `SELECT COUNT(*)::int AS c FROM lesson_steps WHERE owner_id IS NULL`,
          )
        )[0]?.c ?? 0n,
      ),
    };
    if (
      sysBefore.courses === sysAfter.courses &&
      sysBefore.lessons === sysAfter.lessons &&
      sysBefore.steps === sysAfter.steps
    ) {
      ok(`system counts unchanged: ${JSON.stringify(sysAfter)}`);
    } else {
      fail(`system counts changed before=${JSON.stringify(sysBefore)} after=${JSON.stringify(sysAfter)}`);
    }
  } finally {
    try {
      await cleanup(prisma);
      process.stdout.write('CLEANUP OK\n');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cleanup failed', err);
      anyFailure = true;
    }
    await prisma.$disconnect();
  }

  if (anyFailure) {
    process.stdout.write('\nVERIFY FAILED\n');
    process.exit(1);
  }
  process.stdout.write('\nVERIFY OK\n');
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
