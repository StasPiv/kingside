/**
 * KS-2017 / B-1: тесты diff.ts.
 *  - нет курса в БД → action='create';
 *  - совпали все поля → action='unchanged';
 *  - изменён один шаг → action='update' для шага и 'unchanged' для прочих;
 *  - в БД больше шагов чем в файле → 'delete' для лишних;
 *  - в файле больше → 'create'.
 */
import { describe, expect, it } from 'vitest';
import { diffBundle, diffSteps, deepEqual } from '../src/diff.js';
import type {
  DbCourseSnapshot,
  DbLessonSnapshot,
  LessonFileData,
  ParsedBundle,
} from '../src/types.js';

function lesson(steps: Array<{ type: string; [k: string]: unknown }>): LessonFileData {
  return {
    schemaVersion: 1,
    courseSlug: 'c',
    slug: 'l',
    order: 1,
    blockKey: 'b',
    kind: 'theory',
    titleKey: 'x.t',
    summaryKey: 'x.s',
    steps,
  };
}

function dbLesson(steps: Array<{ id: string; order: number; type: string; payload: Record<string, unknown> }>): DbLessonSnapshot {
  return {
    id: 'lid',
    slug: 'l',
    order: 1,
    blockKey: 'b',
    kind: 'theory',
    titleKey: 'x.t',
    summaryKey: 'x.s',
    steps,
  };
}

describe('diff.ts', () => {
  it('создаёт курс если его нет в БД', () => {
    const bundle: ParsedBundle = {
      course: {
        path: '/tmp/x',
        data: {
          schemaVersion: 1,
          slug: 'c',
          level: 'beginner',
          titleKey: 'x.t',
          descriptionKey: 'x.d',
        },
      },
      lessons: [],
    };
    const diff = diffBundle(bundle, null);
    expect(diff.course).toEqual({ slug: 'c', action: 'create' });
  });

  it('unchanged когда все совпало', () => {
    const file: LessonFileData = lesson([
      { type: 'text', bodyMarkdown: 'hello' },
    ]);
    const db: DbLessonSnapshot = dbLesson([
      { id: 'sid', order: 1, type: 'text', payload: { type: 'text', bodyMarkdown: 'hello' } },
    ]);
    const dbCourse: DbCourseSnapshot = { id: 'cid', slug: 'c', lessons: [db] };
    const bundle: ParsedBundle = { lessons: [{ path: '/tmp/x', data: file }] };
    const diff = diffBundle(bundle, dbCourse);
    expect(diff.lessons[0]!.lessonAction).toBe('unchanged');
    expect(diff.lessons[0]!.steps[0]!.action).toBe('unchanged');
  });

  it('update при изменении тела шага', () => {
    const file = lesson([{ type: 'text', bodyMarkdown: 'hello new' }]);
    const db = dbLesson([
      { id: 'sid', order: 1, type: 'text', payload: { type: 'text', bodyMarkdown: 'hello' } },
    ]);
    const diff = diffSteps(file.steps, db.steps);
    expect(diff[0]!.action).toBe('update');
    expect(diff[0]!.details).toContain('payload changed');
  });

  it('delete лишнего шага из БД', () => {
    const file = lesson([{ type: 'text', bodyMarkdown: 'a' }]);
    const db = dbLesson([
      { id: 's1', order: 1, type: 'text', payload: { type: 'text', bodyMarkdown: 'a' } },
      { id: 's2', order: 2, type: 'text', payload: { type: 'text', bodyMarkdown: 'b' } },
    ]);
    const diff = diffSteps(file.steps, db.steps);
    expect(diff).toHaveLength(2);
    expect(diff[0]!.action).toBe('unchanged');
    expect(diff[1]!.action).toBe('delete');
  });

  it('create нового шага если его нет в БД', () => {
    const file = lesson([
      { type: 'text', bodyMarkdown: 'a' },
      { type: 'text', bodyMarkdown: 'b' },
    ]);
    const db = dbLesson([
      { id: 's1', order: 1, type: 'text', payload: { type: 'text', bodyMarkdown: 'a' } },
    ]);
    const diff = diffSteps(file.steps, db.steps);
    expect(diff[1]!.action).toBe('create');
  });

  it('update при смене type', () => {
    const file = lesson([{ type: 'video', url: 'https://youtu.be/x' }]);
    const db = dbLesson([
      { id: 's1', order: 1, type: 'text', payload: { type: 'text', bodyMarkdown: 'a' } },
    ]);
    const diff = diffSteps(file.steps, db.steps);
    expect(diff[0]!.action).toBe('update');
    expect(diff[0]!.details).toContain('type:');
  });
});

describe('deepEqual', () => {
  it('равные примитивы', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
  });
  it('массивы по индексу', () => {
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
  it('объекты независимо от порядка ключей', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
  it('null vs undefined', () => {
    expect(deepEqual(null, undefined)).toBe(false);
  });
});
