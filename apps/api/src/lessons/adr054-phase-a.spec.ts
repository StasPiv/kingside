/**
 * KS-2639 / ADR-054 Phase A — юнит-тесты на новые поля в моделях
 * `Course / Lesson / LessonStep` и поведение сервисов с `ownerId: null`.
 *
 * Реальное поведение partial-unique индексов (одновременное
 * существование системного `(slug, lang)` и пользовательских
 * `(ownerId, slug)`) проверяется интеграционным скриптом
 * `apps/api/src/scripts/verify-adr054-phase-a.ts` — Prisma client в
 * unit-тестах замокан (см. `apps/api/src/__mocks__/prisma-client.mock.ts`),
 * поэтому здесь:
 *   1. compile-time проверка, что `Prisma.CourseUncheckedCreateInput`,
 *      `Prisma.LessonUncheckedCreateInput`, `Prisma.LessonStepUncheckedCreateInput`
 *      принимают новые поля `ownerId` / `isPublic`;
 *   2. runtime-проверка, что сервисы, переключённые на partial-unique
 *      namespace, делают запрос в системном пространстве
 *      (`findFirst({where: { slug, lang, ownerId: null }})`).
 */

import { CoursesService } from './courses.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@kingside/db';

describe('ADR-054 Phase A — KS-2639', () => {
  it('Prisma.CourseUncheckedCreateInput принимает ownerId и isPublic', () => {
    // Compile-time check: если бы поле отсутствовало, TS свалился бы
    // на TS2353/TS2322. Тест собирается → значит схема расширена.
    const input: Prisma.CourseUncheckedCreateInput = {
      slug: 'ks2639-fixture',
      lang: 'ru',
      level: 'beginner',
      titleKey: 'a',
      descriptionKey: 'b',
      ownerId: '11111111-1111-4111-a111-111111111111',
      isPublic: true,
    };
    expect(input.ownerId).toBe('11111111-1111-4111-a111-111111111111');
    expect(input.isPublic).toBe(true);
  });

  it('Prisma.LessonUncheckedCreateInput принимает ownerId (денормализация)', () => {
    const input: Prisma.LessonUncheckedCreateInput = {
      courseId: '22222222-2222-4222-a222-222222222222',
      slug: 'l',
      blockKey: 'b',
      kind: 'theory',
      titleKey: 'tk',
      summaryKey: 'sk',
      ownerId: '11111111-1111-4111-a111-111111111111',
    };
    expect(input.ownerId).toBe('11111111-1111-4111-a111-111111111111');
  });

  it('Prisma.LessonStepUncheckedCreateInput принимает ownerId (денормализация)', () => {
    const input: Prisma.LessonStepUncheckedCreateInput = {
      lessonId: '33333333-3333-4333-a333-333333333333',
      type: 'text',
      payload: {},
      ownerId: '11111111-1111-4111-a111-111111111111',
    };
    expect(input.ownerId).toBe('11111111-1111-4111-a111-111111111111');
  });

  it('CoursesService.getCourseBySlug ищет в системном namespace через ownerId: null', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const userFindUnique = jest.fn().mockResolvedValue(null);
    const prisma = {
      course: { findFirst },
      user: { findUnique: userFindUnique },
    } as unknown as PrismaService;
    const service = new CoursesService(prisma);

    await service.getCourseBySlug('ks2639-no-such', null).catch(() => undefined);

    expect(findFirst).toHaveBeenCalledTimes(1);
    const arg = findFirst.mock.calls[0][0];
    // Phase A контракт: системный курс ищется по (slug, lang) И ownerId
    // обязательно null — иначе попадаем в namespace пользовательских
    // курсов и можем вернуть чужой объект.
    expect(arg.where).toEqual(
      expect.objectContaining({ slug: 'ks2639-no-such', ownerId: null }),
    );
  });
});
