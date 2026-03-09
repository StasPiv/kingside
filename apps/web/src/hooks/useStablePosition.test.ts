import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { fenToPositionObject, useStablePosition } from './useStablePosition';

describe('fenToPositionObject', () => {
  it('parses starting position correctly', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const pos = fenToPositionObject(fen);

    expect(pos['a1']).toEqual({ pieceType: 'wR' });
    expect(pos['e1']).toEqual({ pieceType: 'wK' });
    expect(pos['d8']).toEqual({ pieceType: 'bQ' });
    expect(pos['e2']).toEqual({ pieceType: 'wP' });
    expect(pos['e7']).toEqual({ pieceType: 'bP' });
    expect(Object.keys(pos)).toHaveLength(32);
  });

  it('parses position after 1.e4', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const pos = fenToPositionObject(fen);

    expect(pos['e4']).toEqual({ pieceType: 'wP' });
    expect(pos['e2']).toBeUndefined();
    expect(Object.keys(pos)).toHaveLength(32);
  });

  it('ignores FEN metadata (side to move, castling, en passant)', () => {
    const fen1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const fen2 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w - - 5 10';
    const pos1 = fenToPositionObject(fen1);
    const pos2 = fenToPositionObject(fen2);

    expect(pos1).toEqual(pos2);
  });

  it('handles empty board', () => {
    const fen = '8/8/8/8/8/8/8/8 w - - 0 1';
    const pos = fenToPositionObject(fen);
    expect(Object.keys(pos)).toHaveLength(0);
  });
});

describe('useStablePosition', () => {
  it('returns position object from FEN', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const { result } = renderHook(() => useStablePosition(fen));
    expect(result.current['e1']).toEqual({ pieceType: 'wK' });
    expect(Object.keys(result.current)).toHaveLength(32);
  });

  it('returns same reference when FEN metadata changes but pieces stay', () => {
    const fen1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const fen2 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w - - 5 10';

    const { result, rerender } = renderHook(
      ({ fen }) => useStablePosition(fen),
      { initialProps: { fen: fen1 } },
    );
    const firstRef = result.current;

    rerender({ fen: fen2 });
    expect(result.current).toBe(firstRef); // same reference
  });

  it('returns new reference when pieces actually move', () => {
    const fen1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const fen2 = 'rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

    const { result, rerender } = renderHook(
      ({ fen }) => useStablePosition(fen),
      { initialProps: { fen: fen1 } },
    );
    const firstRef = result.current;

    rerender({ fen: fen2 });
    expect(result.current).not.toBe(firstRef); // new reference
  });
});
