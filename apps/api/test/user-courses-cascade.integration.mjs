#!/usr/bin/env node
/**
 * Integration-проверка каскада UserCourse → UserLesson → UserLessonStep
 * + UserCoursePlayProgress / UserLessonPlayProgress (KS-1828, ADR-026).
 *
 * Работает против реальной PostgreSQL (DATABASE_URL из env либо
 * значение по умолчанию). Не запускается в jest — jest-config глушит
 * Prisma-клиент моком, чтобы юнит-тесты не требовали БД.
 *
 * Запуск:
 *   cd apps/api
 *   DATABASE_URL=postgresql://kingside:kingside@localhost:5432/kingside \
 *     node test/user-courses-cascade.integration.mjs
 *
 * Падает с ненулевым кодом, если каскад не отработал.
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../../packages/db/dist/generated/prisma/client.js';

const prisma = new PrismaClient();

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  // Уникальный test-owner, чтобы не конфликтовать с прочими тестами.
  const ownerId = randomUUID();
  const username = `cascade-test-${ownerId.slice(0, 8)}`;

  try {
    await prisma.user.create({ data: { id: ownerId, username } });

    // Создаём курс → урок → шаг.
    const course = await prisma.userCourse.create({
      data: {
        ownerId,
        slug: `cascade-${ownerId.slice(0, 6)}-test`,
        title: 'Cascade test course',
        description: 'integration',
      },
    });
    const lesson = await prisma.userLesson.create({
      data: { userCourseId: course.id, order: 0, title: 'L1', estMinutes: 5 },
    });
    const step = await prisma.userLessonStep.create({
      data: { userLessonId: lesson.id, order: 0, type: 'text', payload: { bodyMarkdown: 'hi' } },
    });
    const coursePlay = await prisma.userCoursePlayProgress.create({
      data: { userId: ownerId, userCourseId: course.id, completedLessonsCount: 0 },
    });
    const lessonPlay = await prisma.userLessonPlayProgress.create({
      data: { userId: ownerId, userLessonId: lesson.id, completedStepsCount: 0, totalSteps: 1 },
    });

    assert(await prisma.userCourse.findUnique({ where: { id: course.id } }), 'курс создан');
    assert(await prisma.userLesson.findUnique({ where: { id: lesson.id } }), 'урок создан');
    assert(await prisma.userLessonStep.findUnique({ where: { id: step.id } }), 'шаг создан');
    assert(await prisma.userCoursePlayProgress.findUnique({ where: { id: coursePlay.id } }), 'course-progress создан');
    assert(await prisma.userLessonPlayProgress.findUnique({ where: { id: lessonPlay.id } }), 'lesson-progress создан');

    // Удаляем курс → должен снести урок, шаг, оба progress-а.
    await prisma.userCourse.delete({ where: { id: course.id } });

    assert(
      !(await prisma.userCourse.findUnique({ where: { id: course.id } })),
      'после delete курса сам курс удалён',
    );
    assert(
      !(await prisma.userLesson.findUnique({ where: { id: lesson.id } })),
      'каскад: урок удалён вместе с курсом',
    );
    assert(
      !(await prisma.userLessonStep.findUnique({ where: { id: step.id } })),
      'каскад: шаг удалён вместе с уроком',
    );
    assert(
      !(await prisma.userCoursePlayProgress.findUnique({ where: { id: coursePlay.id } })),
      'каскад: course-progress удалён',
    );
    assert(
      !(await prisma.userLessonPlayProgress.findUnique({ where: { id: lessonPlay.id } })),
      'каскад: lesson-progress удалён',
    );

    // Отдельная проверка: User.delete должен снести UserCourse[].
    const course2 = await prisma.userCourse.create({
      data: {
        ownerId,
        slug: `cascade-${ownerId.slice(0, 6)}-user`,
        title: 'Second course',
      },
    });
    await prisma.user.delete({ where: { id: ownerId } });
    assert(
      !(await prisma.userCourse.findUnique({ where: { id: course2.id } })),
      'каскад: UserCourse удалён вместе с User',
    );
    assert(
      !(await prisma.user.findUnique({ where: { id: ownerId } })),
      'User удалён',
    );

    console.log('\nВсе проверки каскада прошли ✓');
  } finally {
    // Защитный cleanup, если где-то упали.
    await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
