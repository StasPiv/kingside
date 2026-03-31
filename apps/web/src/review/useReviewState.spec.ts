// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReviewState } from './useReviewState';
import { parseAnnotatedPgn } from './utils/PgnDeserializer';
import { serializeToAnnotatedPgn } from './utils/PgnSerializer';

describe('useReviewState — SET_NAG and SET_COMMENT', () => {
  function setupWithPgn(pgn: string) {
    const moves = parseAnnotatedPgn(pgn);
    const { result } = renderHook(() => useReviewState());
    act(() => {
      result.current.loadFromPgn(moves);
    });
    return result;
  }

  it('SET_NAG updates move nags', () => {
    const result = setupWithPgn('1. e4 e5 2. Nf3');
    const e4Index = result.current.history[0].globalIndex;

    act(() => {
      result.current.setNag(e4Index, [1]);
    });

    expect(result.current.history[0].nags).toEqual([1]);
    const pgn = serializeToAnnotatedPgn(result.current.history);
    expect(pgn).toContain('e4 $1');
  });

  it('SET_COMMENT updates move comment', () => {
    const result = setupWithPgn('1. e4 e5 2. Nf3');
    const e4Index = result.current.history[0].globalIndex;

    act(() => {
      result.current.setComment(e4Index, 'Хороший ход');
    });

    expect(result.current.history[0].comment).toBe('Хороший ход');
    const pgn = serializeToAnnotatedPgn(result.current.history);
    expect(pgn).toContain('{Хороший ход}');
  });

  it('SET_NAG with empty array removes nags', () => {
    const result = setupWithPgn('1. e4 $1 e5 2. Nf3');
    const e4Index = result.current.history[0].globalIndex;
    expect(result.current.history[0].nags).toEqual([1]);

    act(() => {
      result.current.setNag(e4Index, []);
    });

    expect(result.current.history[0].nags).toBeUndefined();
    const pgn = serializeToAnnotatedPgn(result.current.history);
    expect(pgn).not.toContain('$1');
  });

  it('SET_COMMENT with empty string removes comment', () => {
    const result = setupWithPgn('1. e4 {Test comment} e5');
    const e4Index = result.current.history[0].globalIndex;
    expect(result.current.history[0].comment).toBe('Test comment');

    act(() => {
      result.current.setComment(e4Index, '');
    });

    expect(result.current.history[0].comment).toBeUndefined();
    const pgn = serializeToAnnotatedPgn(result.current.history);
    expect(pgn).not.toContain('{Test comment}');
  });

  it('SET_NAG on non-existent globalIndex does nothing', () => {
    const result = setupWithPgn('1. e4 e5');
    const historyBefore = result.current.history;

    act(() => {
      result.current.setNag(9999, [1]);
    });

    // State reference should not change
    expect(result.current.history).toBe(historyBefore);
  });

  it('PGN is reserialized after SET_NAG', () => {
    const result = setupWithPgn('1. e4 e5 2. Nf3');
    const e5Index = result.current.history[1].globalIndex;

    act(() => {
      result.current.setNag(e5Index, [6]);
    });

    const pgn = serializeToAnnotatedPgn(result.current.history);
    expect(pgn).toBe('1. e4 e5 $6 2. Nf3 *');
  });
});
