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

/**
 * KS-2287 (ADR-038 §6, VC E1) — `SET_VARIATION_COLOR` action.
 *
 * Покрытие:
 *  - set: цвет ставится на root вариации.
 *  - clear (color=null): убирает цвет.
 *  - toggle: re-set другим цветом перезаписывает.
 *  - moveIndex может указывать на ход ВНУТРИ (не head) → root всё равно
 *    находится правильно.
 *  - main-line move → no-op (variation-color неприменим).
 *  - multi-variation: цвета двух разных вариаций независимы.
 *  - PGN round-trip: после SET_VARIATION_COLOR → serialize даёт `[%cvc X]`.
 *  - delete-variation очищает variationColor вместе с ходами (R8).
 */
describe('useReviewState — KS-2287 SET_VARIATION_COLOR', () => {
  function setupWithPgn(pgn: string) {
    const moves = parseAnnotatedPgn(pgn);
    const { result } = renderHook(() => useReviewState());
    act(() => {
      result.current.loadFromPgn(moves);
    });
    return result;
  }

  it('set: цвет ставится на root первой вариации', () => {
    const result = setupWithPgn('1. e4 e5 (1... c5 2. Nf3) 2. Nf3');
    const c5Index = result.current.history[1].variations![0][0].globalIndex;
    act(() => {
      result.current.setVariationColor(c5Index, 'green');
    });
    const root = result.current.history[1].variations![0][0];
    expect(root.variationColor).toBe('green');
  });

  it('clear (null): variationColor становится undefined', () => {
    const result = setupWithPgn('1. e4 e5 (1... c5 {[%cvc B]} 2. Nf3) 2. Nf3');
    const c5Index = result.current.history[1].variations![0][0].globalIndex;
    expect(result.current.history[1].variations![0][0].variationColor).toBe('blue');
    act(() => {
      result.current.setVariationColor(c5Index, null);
    });
    expect(result.current.history[1].variations![0][0].variationColor).toBeUndefined();
  });

  it('toggle: повторный SET с другим цветом — перезаписывает', () => {
    const result = setupWithPgn('1. e4 e5 (1... c5 2. Nf3) 2. Nf3');
    const c5Index = result.current.history[1].variations![0][0].globalIndex;
    act(() => {
      result.current.setVariationColor(c5Index, 'green');
    });
    act(() => {
      result.current.setVariationColor(c5Index, 'red');
    });
    expect(result.current.history[1].variations![0][0].variationColor).toBe('red');
  });

  it('moveIndex указывает на не-head ход вариации → root всё равно красится', () => {
    // 1.e4 e5 (1... c5 2.Nf3 — c5=root, Nf3=деть варианта)
    const result = setupWithPgn('1. e4 e5 (1... c5 2. Nf3) 2. Nf3');
    const variation = result.current.history[1].variations![0];
    const nonHeadIndex = variation[1].globalIndex; // Nf3 в варианте, не head
    act(() => {
      result.current.setVariationColor(nonHeadIndex, 'yellow');
    });
    expect(variation[0].variationColor).toBe('yellow');
    // На самом не-head ходе цвет НЕ ставится (только на root).
    expect(variation[1].variationColor).toBeUndefined();
  });

  it('main-line move → no-op (variation-color неприменим)', () => {
    const result = setupWithPgn('1. e4 e5 2. Nf3');
    const e5Index = result.current.history[1].globalIndex;
    const before = result.current.history;
    act(() => {
      result.current.setVariationColor(e5Index, 'green');
    });
    // State не меняется — main-line move без вариации.
    expect(result.current.history).toBe(before);
    expect(result.current.history[1].variationColor).toBeUndefined();
  });

  it('multi-variation: 2 вариации красятся независимо', () => {
    const result = setupWithPgn(
      '1. e4 e5 (1... c5 2. Nf3) (1... e6 2. d4) 2. Nf3',
    );
    const var1Head = result.current.history[1].variations![0][0]; // c5
    const var2Head = result.current.history[1].variations![1][0]; // e6
    act(() => {
      result.current.setVariationColor(var1Head.globalIndex, 'green');
    });
    act(() => {
      result.current.setVariationColor(var2Head.globalIndex, 'red');
    });
    expect(var1Head.variationColor).toBe('green');
    expect(var2Head.variationColor).toBe('red');
  });

  it('PGN round-trip: SET_VARIATION_COLOR → serialize даёт [%cvc X]', () => {
    const result = setupWithPgn('1. e4 e5 (1... c5 2. Nf3) 2. Nf3');
    const c5Index = result.current.history[1].variations![0][0].globalIndex;
    act(() => {
      result.current.setVariationColor(c5Index, 'blue');
    });
    const pgn = serializeToAnnotatedPgn(result.current.history);
    expect(pgn).toContain('[%cvc B]');
  });

  it('SET_VARIATION_COLOR на несуществующем moveIndex → no-op', () => {
    const result = setupWithPgn('1. e4 e5 (1... c5 2. Nf3) 2. Nf3');
    const before = result.current.history;
    act(() => {
      result.current.setVariationColor(99999, 'green');
    });
    expect(result.current.history).toBe(before);
  });

  it('clear на уже undefined → variationColor остаётся undefined (KS-2294: state ref может смениться, без guard)', () => {
    // KS-2294: убран no-op-guard в reducer'е, чтобы StrictMode не
    // съедал второй reducer-call как «sameAsBefore». Теперь state
    // ref может пересоздаться даже при no-op clear, главное —
    // value корректный.
    const result = setupWithPgn('1. e4 e5 (1... c5 2. Nf3) 2. Nf3');
    const c5Index = result.current.history[1].variations![0][0].globalIndex;
    act(() => {
      result.current.setVariationColor(c5Index, null);
    });
    expect(result.current.history[1].variations![0][0].variationColor).toBeUndefined();
  });

  it('delete-variation удаляет variationColor вместе с ходами (R8)', () => {
    const result = setupWithPgn('1. e4 e5 (1... c5 2. Nf3) 2. Nf3');
    const variation = result.current.history[1].variations![0];
    const c5 = variation[0];
    act(() => {
      result.current.setVariationColor(c5.globalIndex, 'green');
    });
    expect(c5.variationColor).toBe('green');
    // Удаляем вариацию.
    act(() => {
      result.current.removeVariation(c5);
    });
    // Сама вариация исчезла — variationColor исчез вместе с ней.
    expect(result.current.history[1].variations).toBeUndefined();
    // Сериализация PGN после удаления не должна содержать [%cvc].
    const pgn = serializeToAnnotatedPgn(result.current.history);
    expect(pgn).not.toContain('[%cvc');
    // И самой вариации тоже не должно быть.
    expect(pgn).not.toContain('c5');
  });
});
