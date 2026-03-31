import { describe, it, expect } from 'vitest';
import { parseAnnotatedPgn } from './PgnDeserializer';
import { serializeToAnnotatedPgn } from './PgnSerializer';

describe('PgnDeserializer — NAG parsing', () => {
  it('parses $N NAG tokens', () => {
    const moves = parseAnnotatedPgn('1. e4 $1 e5 $6 2. Nf3');
    expect(moves[0].san).toBe('e4');
    expect(moves[0].nags).toEqual([1]);
    expect(moves[1].san).toBe('e5');
    expect(moves[1].nags).toEqual([6]);
    expect(moves[2].san).toBe('Nf3');
    expect(moves[2].nags).toBeUndefined();
  });

  it('parses symbolic NAG annotations (!, !!, ?, ??, !?, ?!)', () => {
    const moves = parseAnnotatedPgn('1. e4! e5?! 2. Nf3!! Nc6??');
    expect(moves[0].nags).toEqual([1]);
    expect(moves[1].nags).toEqual([6]);
    expect(moves[2].nags).toEqual([3]);
    expect(moves[3].nags).toEqual([4]);
  });

  it('parses standalone symbolic NAG tokens', () => {
    const moves = parseAnnotatedPgn('1. e4 ! e5 ?! 2. Nf3');
    expect(moves[0].nags).toEqual([1]);
    expect(moves[1].nags).toEqual([6]);
  });

  it('parses multiple NAGs per move', () => {
    const moves = parseAnnotatedPgn('1. e4 $1 $14 e5');
    expect(moves[0].nags).toEqual([1, 14]);
  });
});

describe('PgnDeserializer — comment parsing', () => {
  it('parses block comments and attaches to previous move', () => {
    const moves = parseAnnotatedPgn('1. e4 {Отличное начало} e5 2. Nf3');
    expect(moves[0].comment).toBe('Отличное начало');
    expect(moves[1].comment).toBeUndefined();
  });

  it('parses comments with NAGs together', () => {
    const moves = parseAnnotatedPgn('1. e4 $1 {Отличное начало} e5 $6 {Сомнительный ход} 2. Nf3');
    expect(moves[0].nags).toEqual([1]);
    expect(moves[0].comment).toBe('Отличное начало');
    expect(moves[1].nags).toEqual([6]);
    expect(moves[1].comment).toBe('Сомнительный ход');
  });

  it('moves without comments have no comment field', () => {
    const moves = parseAnnotatedPgn('1. e4 e5 2. Nf3');
    expect(moves[0].comment).toBeUndefined();
    expect(moves[1].comment).toBeUndefined();
  });
});

describe('PgnSerializer — NAG and comments', () => {
  it('serializes NAGs as $N', () => {
    const moves = parseAnnotatedPgn('1. e4 e5 2. Nf3');
    moves[0].nags = [1];
    moves[1].nags = [6];
    const pgn = serializeToAnnotatedPgn(moves);
    expect(pgn).toContain('e4 $1');
    expect(pgn).toContain('e5 $6');
  });

  it('serializes comments in braces', () => {
    const moves = parseAnnotatedPgn('1. e4 e5 2. Nf3');
    moves[0].comment = 'Отличное начало';
    const pgn = serializeToAnnotatedPgn(moves);
    expect(pgn).toContain('{Отличное начало}');
  });

  it('serializes NAG before comment', () => {
    const moves = parseAnnotatedPgn('1. e4 e5');
    moves[0].nags = [1];
    moves[0].comment = 'Good move';
    const pgn = serializeToAnnotatedPgn(moves);
    expect(pgn).toContain('e4 $1 {Good move}');
  });
});

describe('PgnDeserializer — eval/clock macros', () => {
  it('extracts eval and clock from comments', () => {
    const moves = parseAnnotatedPgn('1. e4 {[%eval 0.18] [%clk 1:59:27]} c5 {[%eval 0.25] [%clk 1:59:46]}');
    expect(moves[0].eval).toBe(0.18);
    expect(moves[0].clock).toBe('1:59:27');
    expect(moves[0].comment).toBeUndefined();
    expect(moves[1].eval).toBe(0.25);
    expect(moves[1].clock).toBe('1:59:46');
  });

  it('preserves human comment alongside macros', () => {
    const moves = parseAnnotatedPgn('1. e4 {[%eval 0.5] Хороший ход [%clk 0:45:00]}');
    expect(moves[0].eval).toBe(0.5);
    expect(moves[0].clock).toBe('0:45:00');
    expect(moves[0].comment).toBe('Хороший ход');
  });
});

describe('PgnSerializer — eval/clock macros', () => {
  it('serializes eval and clock into comments', () => {
    const moves = parseAnnotatedPgn('1. e4 e5');
    moves[0].eval = 0.18;
    moves[0].clock = '1:59:27';
    const pgn = serializeToAnnotatedPgn(moves);
    expect(pgn).toContain('{[%eval 0.18]');
    expect(pgn).toContain('[%clk 1:59:27]}');
  });
});

describe('Round-trip PGN', () => {
  it('preserves NAGs and comments through parse -> serialize', () => {
    const original = '1. e4 $1 {Отличное начало} e5 $6 2. Nf3 *';
    const moves = parseAnnotatedPgn(original);
    const serialized = serializeToAnnotatedPgn(moves);
    expect(serialized).toBe(original);
  });

  it('preserves NAGs in variations', () => {
    const original = '1. e4 $1 e5 (1... d5 $2 {Плохой ход}) 2. Nf3 *';
    const moves = parseAnnotatedPgn(original);
    const serialized = serializeToAnnotatedPgn(moves);
    expect(serialized).toBe(original);
  });

  it('preserves plain PGN without annotations', () => {
    const original = '1. e4 e5 2. Nf3 Nc6 *';
    const moves = parseAnnotatedPgn(original);
    const serialized = serializeToAnnotatedPgn(moves);
    expect(serialized).toBe(original);
  });
});
