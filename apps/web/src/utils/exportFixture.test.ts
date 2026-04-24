import { describe, it, expect } from 'vitest';
import type { CourseFixture } from '../types/editor';
import { exportCourseFixture } from './exportFixture';

function minimalCourse(): CourseFixture {
  return {
    slug: 'beginner',
    level: 'beginner',
    titleI18nKey: 'courses.beginner.title',
    descriptionI18nKey: 'courses.beginner.desc',
    order: 1,
    isPublished: true,
    lessons: [
      {
        id: 'client-lesson-1',
        slug: 'pieces',
        order: 1,
        blockKey: 'rules',
        kind: 'theory',
        titleI18nKey: 'lessons.pieces.title',
        summaryI18nKey: 'lessons.pieces.summary',
        estMinutes: 5,
        steps: [
          {
            id: 'client-step-1',
            order: 1,
            type: 'text',
            payload: {
              type: 'text',
              bodyMarkdown: 'Hello world',
              diagrams: [],
            },
          },
        ],
      },
    ],
  };
}

describe('exportCourseFixture', () => {
  it('возвращает валидный TS-модуль', () => {
    const out = exportCourseFixture(minimalCourse());
    expect(out).toContain("import type { CourseFixture } from '../../fixture-types'");
    expect(out).toContain('const course: CourseFixture = ');
    expect(out).toContain('export default course;');
  });

  it('не включает client-side `id` шагов и уроков в экспорт', () => {
    const out = exportCourseFixture(minimalCourse());
    expect(out).not.toContain('client-lesson-1');
    expect(out).not.toContain('client-step-1');
  });

  it('сохраняет поля курса (slug, level, order, isPublished)', () => {
    const out = exportCourseFixture(minimalCourse());
    expect(out).toContain('slug: "beginner"');
    expect(out).toContain('level: "beginner"');
    expect(out).toContain('order: 1');
    expect(out).toContain('isPublished: true');
  });

  it('сортирует уроки и шаги по order', () => {
    const c = minimalCourse();
    c.lessons = [
      {
        id: 'a',
        slug: 'second',
        order: 2,
        blockKey: 'rules',
        kind: 'theory',
        titleI18nKey: 't2',
        summaryI18nKey: 's2',
        estMinutes: 3,
        steps: [
          {
            id: 's1',
            order: 2,
            type: 'text',
            payload: { type: 'text', bodyMarkdown: 'B' },
          },
          {
            id: 's2',
            order: 1,
            type: 'text',
            payload: { type: 'text', bodyMarkdown: 'A' },
          },
        ],
      },
      {
        id: 'b',
        slug: 'first',
        order: 1,
        blockKey: 'rules',
        kind: 'theory',
        titleI18nKey: 't1',
        summaryI18nKey: 's1',
        estMinutes: 2,
        steps: [],
      },
    ];
    const out = exportCourseFixture(c);
    const firstIdx = out.indexOf('"first"');
    const secondIdx = out.indexOf('"second"');
    expect(firstIdx).toBeLessThan(secondIdx);
    // Порядок шагов по order: сначала bodyMarkdown="A" (order=1), потом "B" (order=2)
    const aIdx = out.indexOf('"A"');
    const bIdx = out.indexOf('"B"');
    expect(aIdx).toBeLessThan(bIdx);
  });

  it('заголовок комментария содержит slug курса для подсказки пути', () => {
    const out = exportCourseFixture(minimalCourse());
    expect(out).toContain('seed/courses/beginner/index.ts');
  });

  it('для пустого slug пишет <slug> в подсказке', () => {
    const c = minimalCourse();
    c.slug = '';
    const out = exportCourseFixture(c);
    expect(out).toContain('seed/courses/<slug>/index.ts');
  });

  it('сохраняет discriminated-union для endgame_drill winCondition', () => {
    const c = minimalCourse();
    c.lessons[0].steps = [
      {
        id: 'x',
        order: 1,
        type: 'endgame_drill',
        payload: {
          type: 'endgame_drill',
          fen: '8/8/8/8/4k3/8/3P4/3K4 w - - 0 1',
          playerSide: 'white',
          skillLevel: 5,
          winCondition: { kind: 'promote' },
        },
      },
    ];
    const out = exportCourseFixture(c);
    expect(out).toContain('type: "endgame_drill"');
    expect(out).toContain('kind: "promote"');
    expect(out).toContain('skillLevel: 5');
  });
});
