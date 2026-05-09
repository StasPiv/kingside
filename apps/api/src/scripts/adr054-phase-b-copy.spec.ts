/**
 * KS-2640 / ADR-054 §4 Phase B — юнит-тесты на helper'ы скриптов
 * копирования.
 *
 * Здесь PrismaClient мокается (см. `apps/api/src/__mocks__/prisma-
 * client.mock.ts`), поэтому проверяем интерфейс функции:
 *   * правильно собирает before/source/after counts;
 *   * правильно вызывает `$executeRawUnsafe` с ожидаемыми SQL-фрагментами;
 *   * корректно передаёт inserted-числа в результат.
 *
 * Реальный SQL и идемпотентность проверяет integration-скрипт
 * `apps/api/src/scripts/verify-adr054-phase-b.ts` (запускается на
 * живой БД, прогон в комментарии задачи).
 */

import type { PrismaClient } from '@kingside/db';
import { copyUserContent } from './adr054-phase-b-copy-courses';
import { copyUserProgress } from './adr054-phase-b-copy-progress';

interface PrismaMock {
  $queryRawUnsafe: jest.Mock;
  $executeRawUnsafe: jest.Mock;
}

function makePrismaMock(opts: {
  // Возвращаемые $queryRawUnsafe count'ы. Очерёдность вызовов в скриптах:
  // before(3) → source(3) → after(3) для copy-courses; before(4) →
  // source(2) → after(4) для copy-progress.
  counts: number[];
  insertedCounts: number[];
}): PrismaMock {
  let countIdx = 0;
  let insertIdx = 0;
  return {
    $queryRawUnsafe: jest.fn(async () => {
      const c = opts.counts[countIdx++] ?? 0;
      return [{ c: BigInt(c) }];
    }),
    $executeRawUnsafe: jest.fn(async () => {
      return opts.insertedCounts[insertIdx++] ?? 0;
    }),
  };
}

describe('ADR-054 Phase B — copyUserContent (KS-2640)', () => {
  it('возвращает before/source/inserted/after из последовательности counts', async () => {
    // 3 before (courses,lessons,lesson_steps) + 3 source + 3 after.
    const counts = [
      0, 0, 0, // before user-owned: пусто.
      2, 5, 12, // source counts user_*.
      2, 5, 12, // after user-owned: всё скопировалось.
    ];
    const prisma = makePrismaMock({ counts, insertedCounts: [2, 5, 12] });
    const r = await copyUserContent(prisma as unknown as PrismaClient);

    expect(r.source).toEqual({ userCourses: 2, userLessons: 5, userLessonSteps: 12 });
    expect(r.inserted).toEqual({ courses: 2, lessons: 5, lessonSteps: 12 });
    expect(r.after).toEqual({ coursesUserOwned: 2, lessonsUserOwned: 5, lessonStepsUserOwned: 12 });
    // Три INSERT...SELECT — на courses, lessons, lesson_steps.
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(3);
    const sqls = prisma.$executeRawUnsafe.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toContain('INSERT INTO courses');
    expect(sqls[0]).toContain('FROM user_courses');
    expect(sqls[0]).toContain('ON CONFLICT (id) DO NOTHING');
    expect(sqls[1]).toContain('INSERT INTO lessons');
    expect(sqls[1]).toContain('FROM user_lessons ul');
    expect(sqls[1]).toContain('JOIN user_courses uc');
    expect(sqls[2]).toContain('INSERT INTO lesson_steps');
    expect(sqls[2]).toContain('JOIN user_lessons ul');
  });

  it('идемпотентность: при пустом source возвращает inserted=0', async () => {
    const counts = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const prisma = makePrismaMock({ counts, insertedCounts: [0, 0, 0] });
    const r = await copyUserContent(prisma as unknown as PrismaClient);
    expect(r.inserted).toEqual({ courses: 0, lessons: 0, lessonSteps: 0 });
  });
});

describe('ADR-054 Phase B — copyUserProgress (KS-2640)', () => {
  it('возвращает before/source/after, не трогает системные счётчики', async () => {
    // Очерёдность: before(4 запроса) → source(2) → after(4).
    const counts = [
      10, 0,    // before.courseProgressSystem, courseProgressUserOwned
      30, 0,    // before.lessonProgressSystem, lessonProgressUserOwned
      3, 7,     // source.userCoursePlay, userLessonPlay
      10, 3,    // after.courseProgressSystem (не изменилось), courseProgressUserOwned
      30, 7,    // after.lessonProgressSystem, lessonProgressUserOwned
    ];
    const prisma = makePrismaMock({ counts, insertedCounts: [3, 7] });
    const r = await copyUserProgress(prisma as unknown as PrismaClient);

    expect(r.source).toEqual({ userCoursePlay: 3, userLessonPlay: 7 });
    expect(r.inserted).toEqual({ courseProgress: 3, lessonProgress: 7 });
    // Системный prog: в before и after одинаков → KS-2640 acceptance
    // «системный прогресс не задет».
    expect(r.before.courseProgressSystem).toBe(r.after.courseProgressSystem);
    expect(r.before.lessonProgressSystem).toBe(r.after.lessonProgressSystem);
    // User-owned после = source.
    expect(r.after.courseProgressUserOwned).toBe(r.source.userCoursePlay);
    expect(r.after.lessonProgressUserOwned).toBe(r.source.userLessonPlay);

    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    const sqls = prisma.$executeRawUnsafe.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toContain('INSERT INTO user_course_progress');
    expect(sqls[0]).toContain('FROM user_course_play_progress');
    expect(sqls[0]).toContain('ON CONFLICT (user_id, course_id) DO NOTHING');
    // Pickup только user-owned курсов через JOIN.
    expect(sqls[0]).toContain('c.owner_id IS NOT NULL');

    expect(sqls[1]).toContain('INSERT INTO user_lesson_progress');
    expect(sqls[1]).toContain('FROM user_lesson_play_progress');
    expect(sqls[1]).toContain('ON CONFLICT (user_id, lesson_id) DO NOTHING');
    expect(sqls[1]).toContain('l.owner_id IS NOT NULL');
  });
});
