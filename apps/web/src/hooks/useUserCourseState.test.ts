import { describe, it, expect } from 'vitest';
import type {
  UserCourseDto,
  UserLessonDto,
  UserLessonStepDto,
} from '@kingside/shared';

import {
  initialUserCourseState,
  userCourseReducer,
} from './useUserCourseState';

/**
 * KS-1858 (FE-R10): тесты чистого reducer'а. Хук — тонкая обёртка
 * через `useReducer`, поэтому достаточно тестов на action-семантику.
 */

function mkCourse(over: Partial<UserCourseDto> = {}): UserCourseDto {
  return {
    id: 'c1',
    ownerId: 'u1',
    slug: 'course-1',
    title: 'Course 1',
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

function mkStep(over: Partial<UserLessonStepDto> = {}): UserLessonStepDto {
  return {
    id: 's1',
    userLessonId: 'l1',
    order: 0,
    type: 'text',
    payload: { type: 'text', bodyMarkdown: '', diagrams: [] },
    ...over,
  };
}

describe('userCourseReducer — loadCourse', () => {
  it('заполняет course + сортирует lessons по order', () => {
    const next = userCourseReducer(initialUserCourseState, {
      type: 'loadCourse',
      course: mkCourse(),
      lessons: [
        mkLesson({ id: 'l3', order: 2 }),
        mkLesson({ id: 'l1', order: 0 }),
        mkLesson({ id: 'l2', order: 1 }),
      ],
    });
    expect(next.course?.id).toBe('c1');
    expect(next.lessons.map((l) => l.id)).toEqual(['l1', 'l2', 'l3']);
    expect(next.stepsByLesson).toEqual({});
    expect(next.saveStatus).toBe('idle');
  });
});

describe('userCourseReducer — updateCourseMeta', () => {
  it('патчит title и isPublic', () => {
    let s = userCourseReducer(initialUserCourseState, {
      type: 'loadCourse',
      course: mkCourse({ title: 'Old' }),
      lessons: [],
    });
    s = userCourseReducer(s, {
      type: 'updateCourseMeta',
      patch: { title: 'New', isPublic: true },
    });
    expect(s.course?.title).toBe('New');
    expect(s.course?.isPublic).toBe(true);
  });

  it('если course=null — state не меняется (safety)', () => {
    const s = userCourseReducer(initialUserCourseState, {
      type: 'updateCourseMeta',
      patch: { title: 'x' },
    });
    expect(s).toBe(initialUserCourseState);
  });
});

describe('userCourseReducer — lessons CRUD', () => {
  const base = userCourseReducer(initialUserCourseState, {
    type: 'loadCourse',
    course: mkCourse(),
    lessons: [mkLesson({ id: 'l1', order: 0 })],
  });

  it('addLesson в конец; order пересчитан, lessonCount обновлён', () => {
    const s = userCourseReducer(base, {
      type: 'addLesson',
      lesson: mkLesson({ id: 'l2', order: 999 }),
    });
    expect(s.lessons.map((l) => [l.id, l.order])).toEqual([
      ['l1', 0],
      ['l2', 1],
    ]);
    expect(s.course?.lessonCount).toBe(2);
  });

  it('addLesson после afterLessonId', () => {
    const withTwo = userCourseReducer(base, {
      type: 'addLesson',
      lesson: mkLesson({ id: 'l2' }),
    });
    const s = userCourseReducer(withTwo, {
      type: 'addLesson',
      lesson: mkLesson({ id: 'l-mid' }),
      afterLessonId: 'l1',
    });
    expect(s.lessons.map((l) => l.id)).toEqual(['l1', 'l-mid', 'l2']);
    // order переиндексирован: 0, 1, 2
    expect(s.lessons.map((l) => l.order)).toEqual([0, 1, 2]);
  });

  it('addLesson с существующим id — noop (не плодит дубли)', () => {
    const s = userCourseReducer(base, {
      type: 'addLesson',
      lesson: mkLesson({ id: 'l1' }),
    });
    expect(s.lessons).toHaveLength(1);
  });

  it('updateLesson — патчит одно поле', () => {
    const s = userCourseReducer(base, {
      type: 'updateLesson',
      id: 'l1',
      patch: { title: 'Renamed' },
    });
    expect(s.lessons[0].title).toBe('Renamed');
  });

  it('deleteLesson — убирает урок, переиндексирует order, обновляет lessonCount, чистит stepsByLesson', () => {
    // Добавим шаги и 2-й урок
    let s = userCourseReducer(base, {
      type: 'addLesson',
      lesson: mkLesson({ id: 'l2' }),
    });
    s = userCourseReducer(s, {
      type: 'setSteps',
      lessonId: 'l1',
      steps: [mkStep({ id: 's1' })],
    });
    s = userCourseReducer(s, {
      type: 'deleteLesson',
      id: 'l1',
    });
    expect(s.lessons.map((l) => l.id)).toEqual(['l2']);
    expect(s.lessons[0].order).toBe(0);
    expect(s.course?.lessonCount).toBe(1);
    expect(s.stepsByLesson.l1).toBeUndefined();
  });

  it('reorderLessons — уроки по списку id; непереданные идут в конец', () => {
    let s = base;
    for (const id of ['l2', 'l3', 'l4']) {
      s = userCourseReducer(s, {
        type: 'addLesson',
        lesson: mkLesson({ id }),
      });
    }
    const reordered = userCourseReducer(s, {
      type: 'reorderLessons',
      orderedIds: ['l3', 'l1'],
    });
    // l3 и l1 — в указанном порядке, l2 и l4 — в конец в insertion order.
    expect(reordered.lessons.map((l) => l.id)).toEqual([
      'l3',
      'l1',
      'l2',
      'l4',
    ]);
    expect(reordered.lessons.map((l) => l.order)).toEqual([0, 1, 2, 3]);
  });
});

describe('userCourseReducer — steps CRUD', () => {
  const base = userCourseReducer(initialUserCourseState, {
    type: 'loadCourse',
    course: mkCourse(),
    lessons: [mkLesson({ id: 'l1', stepCount: 0 })],
  });

  it('setSteps — заполняет кеш, сортирует по order', () => {
    const s = userCourseReducer(base, {
      type: 'setSteps',
      lessonId: 'l1',
      steps: [
        mkStep({ id: 's3', order: 2 }),
        mkStep({ id: 's1', order: 0 }),
        mkStep({ id: 's2', order: 1 }),
      ],
    });
    expect(s.stepsByLesson.l1.map((x) => x.id)).toEqual(['s1', 's2', 's3']);
  });

  it('addStep — в конец, обновляет stepCount урока', () => {
    let s = userCourseReducer(base, {
      type: 'setSteps',
      lessonId: 'l1',
      steps: [mkStep({ id: 's1' })],
    });
    s = userCourseReducer(s, {
      type: 'addStep',
      lessonId: 'l1',
      step: mkStep({ id: 's2', order: 99 }),
    });
    expect(s.stepsByLesson.l1.map((x) => x.id)).toEqual(['s1', 's2']);
    expect(s.stepsByLesson.l1.map((x) => x.order)).toEqual([0, 1]);
    expect(s.lessons[0].stepCount).toBe(2);
  });

  it('addStep после afterStepId', () => {
    let s = userCourseReducer(base, {
      type: 'setSteps',
      lessonId: 'l1',
      steps: [
        mkStep({ id: 's1', order: 0 }),
        mkStep({ id: 's2', order: 1 }),
      ],
    });
    s = userCourseReducer(s, {
      type: 'addStep',
      lessonId: 'l1',
      step: mkStep({ id: 's-mid' }),
      afterStepId: 's1',
    });
    expect(s.stepsByLesson.l1.map((x) => x.id)).toEqual(['s1', 's-mid', 's2']);
  });

  it('updateStep — патчит один шаг', () => {
    let s = userCourseReducer(base, {
      type: 'setSteps',
      lessonId: 'l1',
      steps: [mkStep({ id: 's1', type: 'text' })],
    });
    s = userCourseReducer(s, {
      type: 'updateStep',
      lessonId: 'l1',
      stepId: 's1',
      patch: { type: 'puzzle' },
    });
    expect(s.stepsByLesson.l1[0].type).toBe('puzzle');
  });

  it('deleteStep — убирает, переиндексирует, уменьшает stepCount', () => {
    let s = userCourseReducer(base, {
      type: 'setSteps',
      lessonId: 'l1',
      steps: [
        mkStep({ id: 's1', order: 0 }),
        mkStep({ id: 's2', order: 1 }),
        mkStep({ id: 's3', order: 2 }),
      ],
    });
    // stepCount в lesson'е обновится только если он уже был синхронизирован —
    // для чистоты выставим вручную.
    s = userCourseReducer(s, {
      type: 'updateLesson',
      id: 'l1',
      patch: { stepCount: 3 },
    });
    s = userCourseReducer(s, {
      type: 'deleteStep',
      lessonId: 'l1',
      stepId: 's2',
    });
    expect(s.stepsByLesson.l1.map((x) => x.id)).toEqual(['s1', 's3']);
    expect(s.stepsByLesson.l1.map((x) => x.order)).toEqual([0, 1]);
    expect(s.lessons[0].stepCount).toBe(2);
  });

  it('reorderSteps — по orderedIds; непереданные идут в конец', () => {
    let s = userCourseReducer(base, {
      type: 'setSteps',
      lessonId: 'l1',
      steps: [
        mkStep({ id: 's1' }),
        mkStep({ id: 's2' }),
        mkStep({ id: 's3' }),
      ],
    });
    s = userCourseReducer(s, {
      type: 'reorderSteps',
      lessonId: 'l1',
      orderedIds: ['s3', 's1'],
    });
    expect(s.stepsByLesson.l1.map((x) => x.id)).toEqual(['s3', 's1', 's2']);
    expect(s.stepsByLesson.l1.map((x) => x.order)).toEqual([0, 1, 2]);
  });
});

describe('userCourseReducer — setSaveStatus', () => {
  it('переключает глобальный статус для SaveStatusPill', () => {
    let s = userCourseReducer(initialUserCourseState, {
      type: 'setSaveStatus',
      status: 'saving',
    });
    expect(s.saveStatus).toBe('saving');
    s = userCourseReducer(s, { type: 'setSaveStatus', status: 'error' });
    expect(s.saveStatus).toBe('error');
  });
});
