/**
 * Скрипт идемпотентной накатки seed-фикстур раздела «Уроки».
 *
 * Запуск:
 *   npm run seed:lessons --workspace=@kingside/api
 *
 * Поведение (ADR-024 §2.4):
 *  1. Загружает список курсов из `courses/index.ts`.
 *  2. Прогоняет линтер (см. `./lint.ts`). При любой ошибке — `exitCode=1`,
 *     БД не трогаем.
 *  3. Upsert курса по `slug`, затем upsert уроков по `(courseId, slug)`.
 *     Для каждого урока — полностью переписываем `steps` (deleteMany +
 *     createMany): порядок и состав шагов меняются редко, проще и
 *     надёжнее, чем по одному upsert'у с неустойчивым step-id.
 *  4. **Удаление осиротевших курсов** (KS-1791): курсы, которые есть в
 *     БД, но отсутствуют в фикстурах, удаляются. `ON DELETE CASCADE` на
 *     `lessons.course_id` и `lesson_steps.lesson_id` автоматически снесёт
 *     уроки и шаги. Это гарантирует, что fixture-файлы — единственный
 *     источник истины: удалил курс из фикстур → следующий seed вычищает
 *     его из БД.
 *
 * Важно: fixture `step.id` используется ТОЛЬКО как локальный идентификатор
 * для `UserLessonProgress.stepsState` и линтера. В БД `lesson_steps.id`
 * генерируется Prisma (uuid), и привязка step-id ↔ user progress идёт
 * через поле `order` + `lessonId` — фикстура не диктует БД-id.
 */

import { PrismaClient } from '@kingside/db';
import { COURSES } from './courses';
import { lintFixtures } from './lint';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const errors = await lintFixtures(COURSES, { prisma });
    if (errors.length > 0) {
      process.stderr.write(
        `✗ seed-lessons lint failed (${errors.length} error(s)):\n` +
          errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n') +
          '\n',
      );
      process.exitCode = 1;
      return;
    }

    let coursesUpserted = 0;
    let lessonsUpserted = 0;
    let stepsWritten = 0;

    for (const course of COURSES) {
      // KS-2095: seed-режим всегда RU (root). Composite-key (slug, lang).
      // KS-2639 / ADR-054 §3.1 п.5. compound `slug_lang` снят (заменён
      // на partial-unique с `WHERE owner_id IS NULL`). Prisma typings
      // не поддерживают partial-unique в `upsert.where`, поэтому
      // эмулируем upsert через find-first + update/create в системном
      // namespace (`ownerId: null`).
      const existing = await prisma.course.findFirst({
        where: { slug: course.slug, lang: 'ru', ownerId: null },
      });
      const dbCourse = existing
        ? await prisma.course.update({
            where: { id: existing.id },
            data: {
              level: course.level,
              titleKey: course.titleKey,
              descriptionKey: course.descriptionKey,
              order: course.order,
              isPublished: course.isPublished,
            },
          })
        : await prisma.course.create({
            data: {
              slug: course.slug,
              level: course.level,
              titleKey: course.titleKey,
              descriptionKey: course.descriptionKey,
              order: course.order,
              isPublished: course.isPublished,
            },
          });
      coursesUpserted++;

      for (const lesson of course.lessons) {
        const dbLesson = await prisma.lesson.upsert({
          where: { courseId_slug: { courseId: dbCourse.id, slug: lesson.slug } },
          update: {
            order: lesson.order,
            blockKey: lesson.blockKey,
            kind: lesson.kind,
            titleKey: lesson.titleKey,
            summaryKey: lesson.summaryKey,
            estMinutes: lesson.estMinutes ?? 10,
            isPublished: lesson.isPublished,
          },
          create: {
            courseId: dbCourse.id,
            slug: lesson.slug,
            order: lesson.order,
            blockKey: lesson.blockKey,
            kind: lesson.kind,
            titleKey: lesson.titleKey,
            summaryKey: lesson.summaryKey,
            estMinutes: lesson.estMinutes ?? 10,
            isPublished: lesson.isPublished,
          },
        });
        lessonsUpserted++;

        // Полная перепись шагов — проще и надёжнее при смене порядка.
        await prisma.lessonStep.deleteMany({ where: { lessonId: dbLesson.id } });
        if (lesson.steps.length > 0) {
          await prisma.lessonStep.createMany({
            data: lesson.steps.map((s) => ({
              lessonId: dbLesson.id,
              order: s.order,
              type: s.payload.type,
              payload: s.payload as unknown as object,
            })),
          });
          stepsWritten += lesson.steps.length;
        }
      }
    }

    // Удаляем «осиротевшие» курсы — те, которые есть в БД, но отсутствуют
    // в текущих фикстурах. `ON DELETE CASCADE` (миграция L-03) автоматически
    // каскадно удалит lessons + lesson_steps + user_*_progress.
    const fixtureSlugs = COURSES.map((c) => c.slug);
    const orphanedResult =
      fixtureSlugs.length > 0
        ? await prisma.course.deleteMany({ where: { slug: { notIn: fixtureSlugs } } })
        : await prisma.course.deleteMany({}); // фикстур нет — удаляем все курсы
    const coursesDeleted = orphanedResult.count;

    process.stdout.write(
      `✓ seed-lessons done: ${coursesUpserted} course(s) upserted, ${lessonsUpserted} lesson(s), ${stepsWritten} step(s)` +
        (coursesDeleted > 0 ? `, ${coursesDeleted} orphaned course(s) deleted` : '') +
        '\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  process.stderr.write(`✗ seed-lessons crashed: ${e.stack ?? e}\n`);
  process.exit(1);
});
