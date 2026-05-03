import { describe, it, expect } from 'vitest';

import {
  parseCommentMacros,
  serializeCommentWithMacros,
} from './commentMacros';
import { parseAnnotatedPgn } from './PgnDeserializer';
import { serializeToAnnotatedPgn } from './PgnSerializer';
import type { ChessMove, VariationColor } from '../types';

/**
 * KS-2286 (ADR-038 §4) — PGN-macro `[%cvc X]` для user-variation-color.
 *
 * Покрытие:
 *  - parseCommentMacros: каждый из 4 цветов (G/B/Y/R) → variationColor.
 *  - parseCommentMacros: lowercase допустим.
 *  - parseCommentMacros: невалидная буква (X) → variationColor=undefined,
 *    но макрос удаляется из comment.
 *  - parseCommentMacros: macro сосуществует с [%csl]/[%cal].
 *  - serializeCommentWithMacros: variationColor → `[%cvc X]`.
 *  - serializeCommentWithMacros: undefined → не добавляет макрос.
 *  - parseAnnotatedPgn / serializeToAnnotatedPgn round-trip: PGN с
 *    [%cvc] → парсится → сериализуется → парсится → даёт тот же
 *    move.variationColor.
 *  - Хранение на comment первого хода варианта.
 */

describe('parseCommentMacros — KS-2286 [%cvc X]', () => {
  it.each<[string, VariationColor]>([
    ['[%cvc G]', 'green'],
    ['[%cvc B]', 'blue'],
    ['[%cvc Y]', 'yellow'],
    ['[%cvc R]', 'red'],
  ])('%s → variationColor=%s', (raw, expected) => {
    const parsed = parseCommentMacros(raw);
    expect(parsed.variationColor).toBe(expected);
    // Сам макрос удалён из comment.
    expect(parsed.comment).toBeUndefined();
  });

  it('lowercase допустим: [%cvc g] → green', () => {
    const parsed = parseCommentMacros('[%cvc g]');
    expect(parsed.variationColor).toBe('green');
  });

  it('невалидная буква (X) → variationColor=undefined, макрос удалён', () => {
    const parsed = parseCommentMacros('hello [%cvc X] world');
    expect(parsed.variationColor).toBeUndefined();
    // Невалидный макрос всё равно вычищен — comment без него.
    expect(parsed.comment).toBe('hello  world');
  });

  it('сосуществует с человеческим текстом', () => {
    const parsed = parseCommentMacros('Critical line [%cvc G]');
    expect(parsed.variationColor).toBe('green');
    expect(parsed.comment).toBe('Critical line');
  });

  it('сосуществует с [%csl]/[%cal] в одном комменте', () => {
    const parsed = parseCommentMacros(
      '[%csl Gd4] note [%cal Re2e4] [%cvc B]',
    );
    expect(parsed.variationColor).toBe('blue');
    expect(parsed.annotations?.highlights).toEqual([{ square: 'd4', color: 'green' }]);
    expect(parsed.annotations?.arrows).toEqual([
      { from: 'e2', to: 'e4', color: 'red' },
    ]);
    expect(parsed.comment).toBe('note');
  });
});

describe('serializeCommentWithMacros — KS-2286', () => {
  it('variationColor=green → "[%cvc G]"', () => {
    expect(serializeCommentWithMacros(undefined, undefined, undefined, undefined, 'green'))
      .toBe('[%cvc G]');
  });

  it('все 4 цвета → правильная буква', () => {
    expect(serializeCommentWithMacros(undefined, undefined, undefined, undefined, 'red')).toBe('[%cvc R]');
    expect(serializeCommentWithMacros(undefined, undefined, undefined, undefined, 'green')).toBe('[%cvc G]');
    expect(serializeCommentWithMacros(undefined, undefined, undefined, undefined, 'blue')).toBe('[%cvc B]');
    expect(serializeCommentWithMacros(undefined, undefined, undefined, undefined, 'yellow')).toBe('[%cvc Y]');
  });

  it('variationColor=undefined → макрос не добавляется', () => {
    const result = serializeCommentWithMacros('plain text');
    expect(result).toBe('plain text');
    expect(result).not.toContain('[%cvc');
  });

  it('сосуществует с annotations и человеческим comment', () => {
    const result = serializeCommentWithMacros(
      'note',
      undefined,
      undefined,
      { highlights: [{ square: 'e4', color: 'green' }] },
      'red',
    );
    expect(result).toContain('note');
    expect(result).toContain('[%csl Ge4]');
    expect(result).toContain('[%cvc R]');
    // Порядок: comment → [%csl] → [%cvc] (по convention).
    expect(result).toMatch(/note .*\[%csl.*\].*\[%cvc R\]/);
  });
});

describe('parseAnnotatedPgn — KS-2286 round-trip variationColor', () => {
  it('parse PGN с [%cvc G] на ходе варианта → move.variationColor=green', () => {
    const moves = parseAnnotatedPgn(
      '1. e4 e5 (1... c5 {[%cvc G]} 2. Nf3) 2. Nf3 *',
    );
    // Вариант после e5: первый ход = c5, должен иметь variationColor=green.
    const e5 = moves[1];
    expect(e5.variations).toBeDefined();
    const variation = e5.variations?.[0];
    expect(variation?.[0].san).toBe('c5');
    expect(variation?.[0].variationColor).toBe('green');
  });

  it('round-trip: parse → serialize → parse сохраняет variationColor', () => {
    const original =
      '1. e4 e5 (1... c5 {[%cvc B]} 2. Nf3 {[%cvc R]}) 2. Nf3 *';
    const movesA = parseAnnotatedPgn(original);
    const reserialized = serializeToAnnotatedPgn(movesA);
    const movesB = parseAnnotatedPgn(reserialized);

    function findHead(moves: ChessMove[]): ChessMove {
      const e5 = moves[1];
      const variation = e5.variations?.[0];
      if (!variation) throw new Error('no variation');
      return variation[0];
    }
    function findSecond(moves: ChessMove[]): ChessMove {
      const e5 = moves[1];
      const variation = e5.variations?.[0];
      if (!variation || variation.length < 2) throw new Error('no 2nd move');
      return variation[1];
    }

    expect(findHead(movesB).variationColor).toBe('blue');
    expect(findSecond(movesB).variationColor).toBe('red');

    // ровно те же значения после второго round-trip
    const movesC = parseAnnotatedPgn(serializeToAnnotatedPgn(movesB));
    expect(findHead(movesC).variationColor).toBe('blue');
    expect(findSecond(movesC).variationColor).toBe('red');
  });

  it('serializeToAnnotatedPgn: ход с variationColor → PGN содержит [%cvc X]', () => {
    const moves = parseAnnotatedPgn('1. e4 e5 *');
    moves[0].variationColor = 'yellow';
    const pgn = serializeToAnnotatedPgn(moves);
    expect(pgn).toContain('{[%cvc Y]}');
  });

  it('legacy PGN без [%cvc] → move.variationColor=undefined (back-compat)', () => {
    const moves = parseAnnotatedPgn('1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *');
    const variation = moves[1].variations?.[0];
    expect(variation?.[0].variationColor).toBeUndefined();
  });
});
