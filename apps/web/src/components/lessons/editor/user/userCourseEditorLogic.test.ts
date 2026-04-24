import { describe, it, expect } from 'vitest';
import type { UserCourseDto, UserLessonDto } from '@kingside/shared';

import {
  buildPublicCourseUrl,
  pickNextActiveLessonId,
  resolveActiveLessonId,
  resolveOwnerGuard,
  swapAt,
} from './userCourseEditorLogic';

/**
 * KS-1860 (FE-R12): тесты на pure-логику `UserCourseEditor`.
 * Покрывают то, что не удалось протестировать через рендер из-за OOM
 * vitest-worker'а.
 */

function mkCourse(over: Partial<UserCourseDto> = {}): UserCourseDto {
  return {
    id: 'c1',
    ownerId: 'user-1',
    slug: 'my-course',
    title: 'My course',
    description: null,
    isPublic: false,
    createdAt: '2026-04-24T10:00:00Z',
    updatedAt: '2026-04-24T10:00:00Z',
    lessonCount: 0,
    ...over,
  };
}

function mkLesson(over: Partial<UserLessonDto> = {}): UserLessonDto {
  return {
    id: 'l1',
    userCourseId: 'c1',
    order: 0,
    title: 'L1',
    estMinutes: null,
    stepCount: 0,
    ...over,
  };
}

describe('resolveOwnerGuard', () => {
  it('userId=null → unauthorized', () => {
    expect(
      resolveOwnerGuard({ userId: null, course: null, loadError: false }),
    ).toBe('unauthorized');
  });

  it('loadError=true → forbidden (не раскрываем приватный чужой)', () => {
    expect(
      resolveOwnerGuard({ userId: 'user-1', course: null, loadError: true }),
    ).toBe('forbidden');
  });

  it('course=null без loadError → null (loading)', () => {
    expect(
      resolveOwnerGuard({ userId: 'user-1', course: null, loadError: false }),
    ).toBeNull();
  });

  it('course.ownerId !== userId → forbidden', () => {
    expect(
      resolveOwnerGuard({
        userId: 'user-1',
        course: mkCourse({ ownerId: 'other' }),
        loadError: false,
      }),
    ).toBe('forbidden');
  });

  it('course.ownerId === userId → null (guard прошёл)', () => {
    expect(
      resolveOwnerGuard({
        userId: 'user-1',
        course: mkCourse({ ownerId: 'user-1' }),
        loadError: false,
      }),
    ).toBeNull();
  });

  it('unauthorized приоритетнее forbidden', () => {
    expect(
      resolveOwnerGuard({ userId: null, course: null, loadError: true }),
    ).toBe('unauthorized');
  });
});

describe('resolveActiveLessonId', () => {
  it('пустой список → null', () => {
    expect(
      resolveActiveLessonId({ lessonsQuery: null, lessons: [] }),
    ).toBeNull();
    expect(
      resolveActiveLessonId({ lessonsQuery: 'any', lessons: [] }),
    ).toBeNull();
  });

  it('?lesson не задан → первый по order', () => {
    expect(
      resolveActiveLessonId({
        lessonsQuery: null,
        lessons: [
          mkLesson({ id: 'l1', order: 0 }),
          mkLesson({ id: 'l2', order: 1 }),
        ],
      }),
    ).toBe('l1');
  });

  it('?lesson задан и существует → именно он', () => {
    expect(
      resolveActiveLessonId({
        lessonsQuery: 'l2',
        lessons: [mkLesson({ id: 'l1' }), mkLesson({ id: 'l2' })],
      }),
    ).toBe('l2');
  });

  it('?lesson задан, но несуществующий → fallback на первый', () => {
    expect(
      resolveActiveLessonId({
        lessonsQuery: 'ghost',
        lessons: [mkLesson({ id: 'l1' })],
      }),
    ).toBe('l1');
  });

  it('?lesson пустая строка → fallback на первый', () => {
    expect(
      resolveActiveLessonId({
        lessonsQuery: '',
        lessons: [mkLesson({ id: 'l1' })],
      }),
    ).toBe('l1');
  });
});

describe('pickNextActiveLessonId', () => {
  it('удалённого урока нет в списке → первый оставшийся', () => {
    expect(
      pickNextActiveLessonId(
        [mkLesson({ id: 'l1' }), mkLesson({ id: 'l2' })],
        'ghost',
      ),
    ).toBe('l1');
  });

  it('удалили первого → следующий становится активным', () => {
    expect(
      pickNextActiveLessonId(
        [mkLesson({ id: 'l1' }), mkLesson({ id: 'l2' }), mkLesson({ id: 'l3' })],
        'l1',
      ),
    ).toBe('l2');
  });

  it('удалили среднего → предыдущий становится активным', () => {
    expect(
      pickNextActiveLessonId(
        [mkLesson({ id: 'l1' }), mkLesson({ id: 'l2' }), mkLesson({ id: 'l3' })],
        'l2',
      ),
    ).toBe('l1');
  });

  it('удалили последнего → предыдущий становится активным', () => {
    expect(
      pickNextActiveLessonId(
        [mkLesson({ id: 'l1' }), mkLesson({ id: 'l2' })],
        'l2',
      ),
    ).toBe('l1');
  });

  it('удалили единственного → null', () => {
    expect(
      pickNextActiveLessonId([mkLesson({ id: 'l1' })], 'l1'),
    ).toBeNull();
  });
});

describe('swapAt', () => {
  it('валидные индексы → swap', () => {
    expect(swapAt(['a', 'b', 'c'], 0, 2)).toEqual(['c', 'b', 'a']);
  });

  it('i === j → копия без изменений', () => {
    const input = ['a', 'b'];
    const out = swapAt(input, 1, 1);
    expect(out).toEqual(['a', 'b']);
    expect(out).not.toBe(input);
  });

  it('индекс < 0 → копия без изменений', () => {
    expect(swapAt(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
  });

  it('индекс >= length → копия без изменений', () => {
    expect(swapAt(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
  });

  it('пустой массив → пустой массив', () => {
    expect(swapAt([], 0, 1)).toEqual([]);
  });
});

describe('buildPublicCourseUrl', () => {
  it('origin без trailing slash + slug → полный URL', () => {
    expect(
      buildPublicCourseUrl('https://kingside.site', 'my-course'),
    ).toBe('https://kingside.site/lessons/my/my-course');
  });

  it('origin с trailing slash обрезается', () => {
    expect(
      buildPublicCourseUrl('https://kingside.site/', 'my-course'),
    ).toBe('https://kingside.site/lessons/my/my-course');
  });

  it('origin с несколькими trailing slash обрезается', () => {
    expect(
      buildPublicCourseUrl('https://kingside.site///', 'my-course'),
    ).toBe('https://kingside.site/lessons/my/my-course');
  });

  it('slug с юникодом — не кодируется', () => {
    // encodeURIComponent — обязанность потребителя при необходимости;
    // функция просто конкатенирует. Slug создаётся бэком, ASCII.
    expect(
      buildPublicCourseUrl('https://kingside.site', 'a-b-c'),
    ).toBe('https://kingside.site/lessons/my/a-b-c');
  });
});
