/**
 * KS-2152: round-trip-тест сериализации/десериализации аннотаций
 * (выделения клеток + стрелки) через PGN-комментарий.
 *
 * Проверяет:
 *  - макросы [%csl] / [%cal] корректно генерируются на ноде дерева;
 *  - аннотации стартовой позиции попадают в leading-комментарий PGN;
 *  - после parse → serialize → parse аннотации не теряются и не путаются
 *    между нодами и стартовой позицией.
 */
import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import type { ChessMove, NodeAnnotations } from '../types';
import { serializeToAnnotatedPgn } from './PgnSerializer';
import { parseAnnotatedPgn, extractInitialAnnotations } from './PgnDeserializer';

function makeMove(chess: Chess, san: string, ply: number, globalIndex: number): ChessMove {
  const before = chess.fen();
  const m = chess.move(san);
  if (!m) throw new Error(`bad move: ${san}`);
  return {
    san: m.san,
    fen: chess.fen(),
    from: m.from,
    to: m.to,
    piece: m.piece,
    captured: m.captured,
    promotion: m.promotion,
    flags: m.flags,
    lan: m.from + m.to + (m.promotion ?? ''),
    before,
    after: chess.fen(),
    ply,
    globalIndex,
  };
}

describe('KS-2152 PGN annotations round-trip', () => {
  it('serializes and parses [%csl] (square highlights) on a node', () => {
    const chess = new Chess();
    const e4 = makeMove(chess, 'e4', 1, 0);
    e4.annotations = {
      highlights: [
        { square: 'd4', color: 'red' },
        { square: 'e5', color: 'green' },
      ],
    };

    const pgn = serializeToAnnotatedPgn([e4]);
    expect(pgn).toContain('[%csl Rd4,Ge5]');

    const parsed = parseAnnotatedPgn(pgn);
    expect(parsed[0].annotations?.highlights).toEqual([
      { square: 'd4', color: 'red' },
      { square: 'e5', color: 'green' },
    ]);
  });

  it('serializes and parses [%cal] (arrows) on a node', () => {
    const chess = new Chess();
    const e4 = makeMove(chess, 'e4', 1, 0);
    e4.annotations = {
      arrows: [
        { from: 'e2', to: 'e4', color: 'green' },
        { from: 'g1', to: 'f3', color: 'yellow' },
      ],
    };

    const pgn = serializeToAnnotatedPgn([e4]);
    expect(pgn).toContain('[%cal Ge2e4,Yg1f3]');

    const parsed = parseAnnotatedPgn(pgn);
    expect(parsed[0].annotations?.arrows).toEqual([
      { from: 'e2', to: 'e4', color: 'green' },
      { from: 'g1', to: 'f3', color: 'yellow' },
    ]);
  });

  it('persists initial annotations via leading PGN comment', () => {
    const initial: NodeAnnotations = {
      highlights: [{ square: 'd4', color: 'green' }],
      arrows: [{ from: 'e2', to: 'e4', color: 'red' }],
    };
    const chess = new Chess();
    const e4 = makeMove(chess, 'e4', 1, 0);

    const pgn = serializeToAnnotatedPgn([e4], initial);

    // Leading-комментарий должен идти перед ходами
    expect(pgn).toMatch(/^\{[^}]*\[%csl Gd4\][^}]*\[%cal Re2e4\][^}]*\}\s+1\./);

    const restoredInitial = extractInitialAnnotations(pgn);
    expect(restoredInitial).toEqual(initial);
  });

  it('keeps node annotations independent of initial annotations', () => {
    const initial: NodeAnnotations = {
      highlights: [{ square: 'a1', color: 'blue' }],
    };
    const chess = new Chess();
    const e4 = makeMove(chess, 'e4', 1, 0);
    e4.annotations = { highlights: [{ square: 'h8', color: 'yellow' }] };
    const e5 = makeMove(chess, 'e5', 2, 1);

    const pgn = serializeToAnnotatedPgn([e4, e5], initial);
    const parsedHistory = parseAnnotatedPgn(pgn);
    const parsedInitial = extractInitialAnnotations(pgn);

    expect(parsedInitial?.highlights).toEqual([{ square: 'a1', color: 'blue' }]);
    expect(parsedHistory[0].annotations?.highlights).toEqual([{ square: 'h8', color: 'yellow' }]);
    expect(parsedHistory[1].annotations).toBeUndefined();
  });

  it('coexists with NAGs, comments, eval and clock', () => {
    const chess = new Chess();
    const e4 = makeMove(chess, 'e4', 1, 0);
    e4.nags = [1];
    e4.comment = 'Best by test';
    e4.eval = 0.3;
    e4.clock = '0:01:00';
    e4.annotations = {
      highlights: [{ square: 'd5', color: 'red' }],
      arrows: [{ from: 'e2', to: 'e4', color: 'green' }],
    };

    const pgn = serializeToAnnotatedPgn([e4]);
    const parsed = parseAnnotatedPgn(pgn);
    const m = parsed[0];

    expect(m.nags).toEqual([1]);
    expect(m.comment).toBe('Best by test');
    expect(m.eval).toBeCloseTo(0.3, 2);
    expect(m.clock).toBe('0:01:00');
    expect(m.annotations?.highlights).toEqual([{ square: 'd5', color: 'red' }]);
    expect(m.annotations?.arrows).toEqual([{ from: 'e2', to: 'e4', color: 'green' }]);
  });

  it('does not emit empty macros when there are no annotations', () => {
    const chess = new Chess();
    const e4 = makeMove(chess, 'e4', 1, 0);
    const pgn = serializeToAnnotatedPgn([e4]);
    expect(pgn).not.toContain('[%csl');
    expect(pgn).not.toContain('[%cal');
  });
});
