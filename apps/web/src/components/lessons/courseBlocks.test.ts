import { describe, it, expect } from 'vitest';
import {
  groupLessonsByBlock,
  getBlockKey,
  BLOCK_ORDER,
  OTHER_BLOCK_KEY,
} from './courseBlocks';
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
  it('возвращает blockKey из API как есть для известных ключей', () => {
    expect(getBlockKey(lesson('l1', 0, 'rules'))).toBe('rules');
    expect(getBlockKey(lesson('l2', 1, 'tactics'))).toBe('tactics');
    expect(getBlockKey(lesson('l3', 2, 'basic-endgames'))).toBe(
      'basic-endgames',
    );
  });

  // KS-2036: раньше неизвестный blockKey принудительно сваливался в
  // 'other'. Теперь он возвращается как есть — секция строится
  // автоматически.
  it('неизвестный blockKey возвращается как есть (KS-2036)', () => {
    expect(getBlockKey(lesson('l1', 0, 'something-new'))).toBe('something-new');
  });

  it('пустой/отсутствующий blockKey → other', () => {
    expect(getBlockKey(lesson('l1', 0, ''))).toBe(OTHER_BLOCK_KEY);
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

  // KS-2036: неизвестный blockKey теперь даёт собственную секцию (не
  // 'other'). Секция встаёт после известных, до 'other'.
  it('неизвестный blockKey → своя секция между known и other (KS-2036)', () => {
    const blocks = groupLessonsByBlock([
      lesson('a', 0, 'tactics'),
      lesson('b', 1, 'mystery-block'),
      lesson('c', 2, ''),
    ]);
    expect(blocks.map((b) => b.key)).toEqual([
      'tactics',
      'mystery-block',
      OTHER_BLOCK_KEY,
    ]);
    expect(blocks[1].lessons[0].slug).toBe('b');
    expect(blocks[2].lessons[0].slug).toBe('c');
  });

  // KS-2036: regression — все 5 уроков курса capablanca-primer должны
  // попасть в свои блоки, в т.ч. с blockKey'ами, которых до KS-2036
  // не было в коде (`basic-endgames`, `pawn-endgames`, `piece-values`).
  it('capablanca-primer: все blockKey курса корректно сгруппированы (KS-2036)', () => {
    const blocks = groupLessonsByBlock([
      lesson('ch1', 0, 'rules'),
      lesson('ch2-p1', 1, 'basic-mates'),
      lesson('ch2-p2', 2, 'basic-endgames'),
      lesson('ch2-p3', 3, 'pawn-endgames'),
      lesson('ch2-p4', 4, 'piece-values'),
    ]);
    expect(blocks.map((b) => b.key)).toEqual([
      'rules',
      'basic-mates',
      'piece-values',
      'basic-endgames',
      'pawn-endgames',
    ]);
    expect(blocks.flatMap((b) => b.lessons.map((l) => l.slug))).toEqual([
      'ch1',
      'ch2-p1',
      'ch2-p4',
      'ch2-p2',
      'ch2-p3',
    ]);
  });

  it('порядок известных блоков фиксирован (BLOCK_ORDER)', () => {
    expect(BLOCK_ORDER).toEqual([
      'rules',
      'basic-mates',
      'piece-values',
      'openings',
      'tactics',
      'basic-endgames',
      'pawn-endgames',
      'other',
    ]);
  });
});
