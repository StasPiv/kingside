/**
 * KS-3699. Тесты для `mergeFactors` (3 ветки объединения по acceptance)
 * и `playOutPv` (нормальная линия + защита от мусорной pv).
 */
import { describe, it, expect } from 'vitest';

import type { PositionalSubterm } from '@kingside/shared';

import { mergeFactors, playOutPv } from './factorsMerge';

const FEN_START =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('mergeFactors', () => {
  it('фактор есть в обеих позициях → один элемент с исходным и терминальным значением', () => {
    const initial: PositionalSubterm[] = [
      { id: 'space', value_mg: 0.1, value_eg: 0.05 },
    ];
    const terminal: PositionalSubterm[] = [
      { id: 'space', value_mg: 0.3, value_eg: 0.2 },
    ];
    const merged = mergeFactors(initial, terminal);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      id: 'space',
      value_mg: 0.1,
      value_eg: 0.05,
      terminal_value_mg: 0.3,
      terminal_value_eg: 0.2,
    });
  });

  it('фактор только в исходной → один элемент без terminal-значений', () => {
    const initial: PositionalSubterm[] = [
      {
        id: 'pawn_isolated',
        square: 'a2',
        color: 'w',
        value_mg: -0.05,
        value_eg: -0.07,
      },
    ];
    const merged = mergeFactors(initial, []);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      id: 'pawn_isolated',
      square: 'a2',
      color: 'w',
      value_mg: -0.05,
      value_eg: -0.07,
    });
    expect(merged[0].terminal_value_mg).toBeUndefined();
    expect(merged[0].terminal_value_eg).toBeUndefined();
  });

  it('фактор только в конечной → один элемент только с terminal-значениями', () => {
    const terminal: PositionalSubterm[] = [
      {
        id: 'passed_rank',
        square: 'd6',
        color: 'w',
        value_mg: 0.4,
        value_eg: 0.9,
      },
    ];
    const merged = mergeFactors([], terminal);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      id: 'passed_rank',
      square: 'd6',
      color: 'w',
      terminal_value_mg: 0.4,
      terminal_value_eg: 0.9,
    });
    expect(merged[0].value_mg).toBeUndefined();
    expect(merged[0].value_eg).toBeUndefined();
  });

  it('факторы с одинаковым id, но разными square/color не схлопываются', () => {
    const initial: PositionalSubterm[] = [
      { id: 'pawn_isolated', square: 'a2', color: 'w', value_mg: -0.05, value_eg: -0.05 },
      { id: 'pawn_isolated', square: 'h7', color: 'b', value_mg: -0.04, value_eg: -0.04 },
    ];
    const terminal: PositionalSubterm[] = [
      { id: 'pawn_isolated', square: 'a2', color: 'w', value_mg: -0.06, value_eg: -0.06 },
    ];
    const merged = mergeFactors(initial, terminal);
    expect(merged).toHaveLength(2);
    const a2 = merged.find((m) => m.square === 'a2');
    const h7 = merged.find((m) => m.square === 'h7');
    expect(a2?.terminal_value_mg).toBe(-0.06);
    expect(h7?.terminal_value_mg).toBeUndefined();
  });

  it('порядок: сначала исходные (в исходном порядке), затем «только терминальные»', () => {
    const initial: PositionalSubterm[] = [
      { id: 'space', value_mg: 0.1, value_eg: 0 },
      { id: 'material', value_mg: 0, value_eg: 0 },
    ];
    const terminal: PositionalSubterm[] = [
      { id: 'material', value_mg: 0.3, value_eg: 0.3 },
      { id: 'king_danger', value_mg: 0.2, value_eg: 0 },
    ];
    const merged = mergeFactors(initial, terminal);
    expect(merged.map((m) => m.id)).toEqual(['space', 'material', 'king_danger']);
  });
});

describe('playOutPv', () => {
  it('валидная pv → FEN конечной позиции', () => {
    const fen = playOutPv(FEN_START, 'e2e4 e7e5 g1f3');
    expect(fen).not.toBeNull();
    // После 1.e4 e5 2.Nf3 ход чёрных, FEN начинается с расстановки.
    expect(fen).toMatch(/^rnbqkbnr\/pppp.ppp/);
    expect(fen).toContain(' b '); // ход чёрных
  });

  it('пустая pv → null', () => {
    expect(playOutPv(FEN_START, '')).toBeNull();
    expect(playOutPv(FEN_START, '   ')).toBeNull();
  });

  it('нелегальный ход → null (вся линия игнорируется)', () => {
    expect(playOutPv(FEN_START, 'e2e5')).toBeNull();
  });

  it('невалидный UCI (короткий/мусор) → null', () => {
    expect(playOutPv(FEN_START, 'xx')).toBeNull();
    expect(playOutPv(FEN_START, 'e2e4 garbage')).toBeNull();
  });

  it('невалидный стартовый FEN → null', () => {
    expect(playOutPv('not a fen', 'e2e4')).toBeNull();
  });
});
