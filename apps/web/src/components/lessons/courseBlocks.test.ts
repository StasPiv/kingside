import { describe, it, expect } from 'vitest';
import { groupLessonsByBlock, getBlockKey, BLOCK_ORDER } from './courseBlocks';
import type { CourseLessonSummary } from '@kingside/shared';

function lesson(slug: string, order: number, extra?: Partial<CourseLessonSummary>): CourseLessonSummary {
  return {
    id: `id-${slug}`,
    slug,
    order,
    kind: 'theory',
    titleI18nKey: `t.${slug}`,
    summaryI18nKey: `s.${slug}`,
    stepCount: 2,
    progressState: 'not_started',
    ...extra,
  } as CourseLessonSummary;
}

describe('getBlockKey', () => {
  it('маппит slug курса beginner в правильный block', () => {
    expect(getBlockKey(lesson('board-coordinates', 0))).toBe('rules');
    expect(getBlockKey(lesson('mate-queen-king', 8))).toBe('basic-mates');
    expect(getBlockKey(lesson('piece-values', 12))).toBe('piece-values');
    expect(getBlockKey(lesson('opening-principles', 15))).toBe('openings');
    expect(getBlockKey(lesson('fork', 20))).toBe('tactics');
    expect(getBlockKey(lesson('king-pawn-vs-king', 26))).toBe('basic-endgame');
  });

  it('неизвестный slug → other', () => {
    expect(getBlockKey(lesson('something-new', 99))).toBe('other');
  });

  it('предпочитает API-поле blockKey, если есть', () => {
    const l = lesson('board-coordinates', 0) as CourseLessonSummary & { blockKey: string };
    l.blockKey = 'tactics';
    expect(getBlockKey(l)).toBe('tactics');
  });
});

describe('groupLessonsByBlock', () => {
  it('группирует все 30 slug-ов курса beginner в 6 блоков, в правильном порядке', () => {
    const all = [
      'board-coordinates','pawn-moves','knight-moves','bishop-moves','rook-moves',
      'queen-moves','king-and-castling','check-mate-draw',
      'mate-queen-king','mate-rook-king','mate-two-rooks','mate-patterns-recognition',
      'piece-values','exchanges','hanging-pieces',
      'opening-principles','center-control','piece-development','castling-when','opening-mistakes',
      'fork','pin','double-attack','discovered-attack','discovered-check','mate-in-one-two',
      'king-pawn-vs-king','pawn-promotion','active-king-endgame','stalemate-tricks',
    ].map((s, i) => lesson(s, i));
    const blocks = groupLessonsByBlock(all);
    expect(blocks.map((b) => b.key)).toEqual([
      'rules','basic-mates','piece-values','openings','tactics','basic-endgame',
    ]);
    expect(blocks[0].lessons.map((l) => l.slug)).toContain('board-coordinates');
    expect(blocks[1].lessons.length).toBe(4);
    expect(blocks[2].lessons.length).toBe(3);
    expect(blocks[3].lessons.length).toBe(5);
    expect(blocks[4].lessons.length).toBe(6);
    expect(blocks[5].lessons.length).toBe(4);
    // итого 30
    expect(blocks.reduce((acc, b) => acc + b.lessons.length, 0)).toBe(30);
  });

  it('внутри блока уроки идут по order', () => {
    const blocks = groupLessonsByBlock([
      lesson('mate-rook-king', 9),
      lesson('mate-queen-king', 8),
      lesson('mate-two-rooks', 10),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lessons.map((l) => l.order)).toEqual([8, 9, 10]);
  });

  it('пустые блоки не отдаёт', () => {
    const blocks = groupLessonsByBlock([lesson('fork', 20)]);
    expect(blocks.map((b) => b.key)).toEqual(['tactics']);
  });

  it('неизвестные slug-и попадают в блок other (последний)', () => {
    const blocks = groupLessonsByBlock([
      lesson('fork', 20),
      lesson('mystery-lesson', 100),
    ]);
    expect(blocks.map((b) => b.key)).toEqual(['tactics', 'other']);
    expect(blocks[1].lessons[0].slug).toBe('mystery-lesson');
  });

  it('порядок блоков фиксирован (BLOCK_ORDER)', () => {
    expect(BLOCK_ORDER).toEqual([
      'rules','basic-mates','piece-values','openings','tactics','basic-endgame','other',
    ]);
  });
});
