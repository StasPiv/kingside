/**
 * KS-1954: idempotent seed для DEV-юзера c ≥2 активных курсов
 * одновременно — нужно frontend'у, чтобы визуально проверить Hero
 * Variant C на странице «Уроки» (KS-1938).
 *
 * Запуск:
 *   `npm run seed:hero-multi --workspace=@kingside/api`
 *
 * Что делает:
 *   1. Берёт DEV-юзера (создаётся `packages/db/prisma/seed.ts`).
 *   2. Находит все опубликованные системные курсы (после
 *      `seed-lessons.ts` их минимум 2 — `demo` + `mate-patterns`).
 *   3. Для каждого делает upsert `UserCourseProgress` с
 *      `completedAt = null`, `currentLessonId` = первый урок курса.
 *      `updatedAt` сам обновится через `@updatedAt`.
 *
 * После запуска `GET /api/lessons/courses` для DEV-юзера вернёт
 * `progress.completedAt = null` минимум для двух курсов → фронт
 * рендерит Hero Variant C.
 *
 * Идемпотентно: повторные запуски не создают дубликатов
 * (`@@unique([userId, courseId])`).
 *
 * Очистка: чтобы вернуться в исходное состояние (Variant A) — удали
 * руками `DELETE FROM user_course_progress WHERE user_id = '<DEV_USER_ID>'`.
 */

import 'dotenv/config';
import { PrismaClient } from '@kingside/db';
import { DEV_USER_ID } from '@kingside/shared';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const dev = await prisma.user.findUnique({ where: { id: DEV_USER_ID } });
    if (!dev) {
      process.stderr.write(
        '✗ seed-hero-multi: DEV user not found in DB. ' +
          'Run `npm run prisma:seed --workspace=@kingside/db` first.\n',
      );
      process.exit(1);
    }

    const courses = await prisma.course.findMany({
      where: { isPublished: true },
      orderBy: [{ level: 'asc' }, { order: 'asc' }],
      include: {
        lessons: {
          where: { isPublished: true },
          orderBy: [{ blockKey: 'asc' }, { order: 'asc' }],
          select: { id: true },
        },
      },
    });

    if (courses.length < 2) {
      process.stderr.write(
        `✗ seed-hero-multi: need ≥2 published system courses, got ${courses.length}. ` +
          'Run `npm run seed:lessons --workspace=@kingside/api` first.\n',
      );
      process.exit(1);
    }

    let upserted = 0;
    for (const course of courses) {
      const firstLessonId = course.lessons[0]?.id ?? null;
      await prisma.userCourseProgress.upsert({
        where: {
          userId_courseId: { userId: DEV_USER_ID, courseId: course.id },
        },
        update: {
          // Активный прогресс: completedAt сбрасываем, чтобы курс
          // считался «в работе» даже если ранее был отмечен как
          // пройденный (для повторной верификации Variant C).
          completedAt: null,
          currentLessonId: firstLessonId,
        },
        create: {
          userId: DEV_USER_ID,
          courseId: course.id,
          completedAt: null,
          currentLessonId: firstLessonId,
        },
      });
      upserted++;
    }

    process.stdout.write(
      `✓ seed-hero-multi done: ${upserted} active UserCourseProgress for DEV ` +
        `(${DEV_USER_ID}). Hero Variant C should render now.\n`,
    );
    for (const c of courses) {
      process.stdout.write(`  - ${c.slug} (${c.level})\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  process.stderr.write(`✗ seed-hero-multi crashed: ${e.stack ?? e}\n`);
  process.exit(1);
});
