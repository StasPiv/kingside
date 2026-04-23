import { describe, it, expect } from 'vitest';
import { groupLessonsByBlock, getBlockKey, BLOCK_ORDER } from './courseBlocks';
import type { CourseLessonSummary } from '@kingside/shared';

function lesson(
  slug: string,
  order: number,
  blockKey: string,
  extra?: Partial<CourseLessonSummary>,
): CourseLessonSummary {
  return {
    id: `id-${slug}`,
    slug,
    order,
    blockKey,
    kind: 'theory',
    titleI18nKey: `t.${slug}`,
    summaryI18nKey: `s.${slug}`,
    stepCount: 2,
    progressState: 'not_started',
    ...extra,
  } as CourseLessonSummary;
}

describe('getBlockKey', () => {
  it('возвращает blockKey из API, если он входит в BLOCK_ORDER', () => {
    expect(getBlockKey(lesson('l1', 0, 'rules'))).toBe('rules');
    expect(getBlockKey(lesson('l2', 1, 'tactics'))).toBe('tactics');
    expect(getBlockKey(lesson('l3', 2, 'basic-endgame'))).toBe('basic-endgame');
  });

  it('неизвестный blockKey → other', () => {
    expect(getBlockKey(lesson('l1', 0, 'something-new'))).toBe('other');
  });

  it('пустой blockKey → other', () => {
    expect(getBlockKey(lesson('l1', 0, ''))).toBe('other');
  });
});

describe('groupLessonsByBlock', () => {
  it('группирует уроки по blockKey в порядке BLOCK_ORDER', () => {
    const lessons = [
      lesson('a', 0, 'tactics'),
      lesson('b', 1, 'rules'),
      lesson('c', 2, 'basic-mates'),
      lesson('d', 3, 'rules'),
    ];
    const blocks = groupLessonsByBlock(lessons);
    expect(blocks.map((b) => b.key)).toEqual(['rules', 'basic-mates', 'tactics']);
    expect(blocks[0].lessons.map((l) => l.slug)).toEqual(['b', 'd']);
  });

  it('внутри блока уроки идут по order', () => {
    const blocks = groupLessonsByBlock([
      lesson('x', 9, 'basic-mates'),
      lesson('y', 8, 'basic-mates'),
      lesson('z', 10, 'basic-mates'),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lessons.map((l) => l.order)).toEqual([8, 9, 10]);
  });

  it('пустые блоки не отдаёт', () => {
    const blocks = groupLessonsByBlock([lesson('a', 0, 'tactics')]);
    expect(blocks.map((b) => b.key)).toEqual(['tactics']);
  });

  it('неизвестные blockKey попадают в блок other (последний)', () => {
    const blocks = groupLessonsByBlock([
      lesson('a', 0, 'tactics'),
      lesson('b', 1, 'mystery'),
    ]);
    expect(blocks.map((b) => b.key)).toEqual(['tactics', 'other']);
    expect(blocks[1].lessons[0].slug).toBe('b');
  });

  it('порядок блоков фиксирован (BLOCK_ORDER)', () => {
    expect(BLOCK_ORDER).toEqual([
      'rules',
      'basic-mates',
      'piece-values',
      'openings',
      'tactics',
      'basic-endgame',
      'other',
    ]);
  });
});
