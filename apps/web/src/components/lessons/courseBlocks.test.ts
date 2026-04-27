import { describe, it, expect } from 'vitest';
import {
  groupLessonsByBlock,
  getBlockKey,
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
  it('возвращает blockKey из API как есть для непустого значения', () => {
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
  it('упорядочивает блоки по переданному blockOrder (KS-2038)', () => {
    const lessons = [
      lesson('a', 0, 'tactics'),
      lesson('b', 1, 'rules'),
      lesson('c', 2, 'basic-mates'),
      lesson('d', 3, 'rules'),
    ];
    const blocks = groupLessonsByBlock(lessons, [
      'rules',
      'basic-mates',
      'tactics',
    ]);
    expect(blocks.map((b) => b.key)).toEqual(['rules', 'basic-mates', 'tactics']);
    expect(blocks[0].lessons.map((l) => l.slug)).toEqual(['b', 'd']);
  });

  it('внутри блока уроки идут по order', () => {
    const blocks = groupLessonsByBlock(
      [
        lesson('x', 9, 'basic-mates'),
        lesson('y', 8, 'basic-mates'),
        lesson('z', 10, 'basic-mates'),
      ],
      ['basic-mates'],
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lessons.map((l) => l.order)).toEqual([8, 9, 10]);
  });

  it('пустые блоки не отдаёт — даже если они в blockOrder', () => {
    const blocks = groupLessonsByBlock(
      [lesson('a', 0, 'tactics')],
      ['rules', 'basic-mates', 'tactics'],
    );
    expect(blocks.map((b) => b.key)).toEqual(['tactics']);
  });

  // KS-2038: blockKey не из переданного blockOrder идёт ПОСЛЕ
  // упорядоченных, в порядке первого появления в массиве уроков.
  it('blockKey вне blockOrder → после known, до other (KS-2038)', () => {
    const blocks = groupLessonsByBlock(
      [
        lesson('a', 0, 'tactics'),
        lesson('b', 1, 'mystery-block'),
        lesson('c', 2, ''),
      ],
      ['tactics'],
    );
    expect(blocks.map((b) => b.key)).toEqual([
      'tactics',
      'mystery-block',
      OTHER_BLOCK_KEY,
    ]);
    expect(blocks[1].lessons[0].slug).toBe('b');
    expect(blocks[2].lessons[0].slug).toBe('c');
  });

  // KS-2038: пустой blockOrder → порядок «как пришло из API» (по
  // первому появлению), `'other'` всё равно последним.
  it('пустой blockOrder → порядок по первому появлению, other последним', () => {
    const blocks = groupLessonsByBlock(
      [
        lesson('a', 0, ''),
        lesson('b', 1, 'tactics'),
        lesson('c', 2, 'rules'),
      ],
      [],
    );
    expect(blocks.map((b) => b.key)).toEqual([
      'tactics',
      'rules',
      OTHER_BLOCK_KEY,
    ]);
  });

  it('blockOrder не передан → fallback такой же как пустой', () => {
    const blocks = groupLessonsByBlock([
      lesson('a', 0, 'tactics'),
      lesson('b', 1, 'rules'),
    ]);
    expect(blocks.map((b) => b.key)).toEqual(['tactics', 'rules']);
  });

  // KS-2038: реальный кейс — capablanca-primer с blockOrder из API,
  // блоки идут в методическом порядке учебника.
  it('capablanca-primer: blocks следуют blockOrder из API (KS-2038)', () => {
    const blocks = groupLessonsByBlock(
      [
        // Уроки умышленно перемешаны — порядок задаёт blockOrder.
        lesson('ch2-p4', 4, 'piece-values'),
        lesson('ch2-p2', 2, 'basic-endgames'),
        lesson('ch1', 0, 'rules'),
        lesson('ch2-p3', 3, 'pawn-endgames'),
        lesson('ch2-p1', 1, 'basic-mates'),
      ],
      [
        'rules',
        'basic-mates',
        'basic-endgames',
        'pawn-endgames',
        'piece-values',
      ],
    );
    expect(blocks.map((b) => b.key)).toEqual([
      'rules',
      'basic-mates',
      'basic-endgames',
      'pawn-endgames',
      'piece-values',
    ]);
    expect(blocks.flatMap((b) => b.lessons.map((l) => l.slug))).toEqual([
      'ch1',
      'ch2-p1',
      'ch2-p2',
      'ch2-p3',
      'ch2-p4',
    ]);
  });
});
