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

/**
 * KS-3039: variation на ply=0 (root, currentMove === null).
 *
 * Симптом до фикса: ход с начальной позиции, отличный от первого
 * хода основной линии, через `makeVariantMove` фолбэкал в ADD_MOVE,
 * который через addMoveToHistory затирал всю историю (`if (!currentMove)
 * return [newMove]`). На ply >= 1 поведение работало корректно
 * (variation на `currentMove.next`).
 *
 * Фикс: makeVariantMove распознаёт root-with-history как «main-line
 * имеет продолжение» (history[0]), а ADD_VARIATION reducer
 * синтезирует виртуальный branch-point `{next: history[0]}` и
 * добавляет variation на history[0].
 */
describe('useReviewState — KS-3039 root variation (ply=0)', () => {
  function setupWithPgn(pgn: string) {
    const moves = parseAnnotatedPgn(pgn);
    const { result } = renderHook(() => useReviewState());
    act(() => {
      result.current.loadFromPgn(moves);
    });
    return result;
  }

  it('альтернативный first-move создаёт variation на history[0], основная линия сохранена', () => {
    const result = setupWithPgn('1. e4 e5 2. Nf3');
    const historyBefore = result.current.history;
    expect(historyBefore.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3']);

    // Возвращаемся в root (до 1.e4).
    act(() => {
      result.current.gotoFirst();
    });
    expect(result.current.currentMove).toBeNull();

    // Играем d4 — альтернативный первый ход.
    act(() => {
      result.current.makeVariantMove('d2', 'd4');
    });

    // Основная линия не потеряна.
    expect(result.current.history.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3']);

    // Variation осела на history[0] (= e4) как альтернатива первому ходу.
    const rootVariations = result.current.history[0].variations;
    expect(rootVariations).toBeDefined();
    expect(rootVariations!.length).toBe(1);
    expect(rootVariations![0][0].san).toBe('d4');

    // KS-3039 follow-up: ply варианта должен совпадать с ply
    // history[0] (= 1 для обычного e4-старта). Раньше формула
    // `(currentMove?.ply ?? 0) + 1` давала ply=1 случайно — но
    // здесь это и есть верное значение.
    expect(rootVariations![0][0].ply).toBe(result.current.history[0].ply);
    expect(rootVariations![0][0].ply).toBe(1);

    // Навигация переключилась на новый ход.
    expect(result.current.currentMove?.san).toBe('d4');

    // PGN сериализуется со скобочной нотацией для root-варианта.
    const pgn = serializeToAnnotatedPgn(result.current.history);
    expect(pgn).toContain('1. e4');
    expect(pgn).toContain('d4');
    expect(pgn).toContain('(');
  });

  /**
   * KS-3039 follow-up: партия загружена из PGN c FEN-header `... b ... 0 25`
   * (фрагмент игры с `25...<SAN>`). history[0].ply = 50. Альтернативный
   * первый ход с root должен иметь ply=50 (а не 1) и отображаться как
   * `25...<SAN>`, а не `1.<SAN>`. До фикса формула выставляла ply=1
   * вне зависимости от того, какой ply у history[0].
   */
  it('FEN-фрагмент с ply=50 (25...a6 ...) — альтернативный first-move наследует ply=50', () => {
    // Воспроизводим реальный flow AnalysisPage: setInitialFen(FEN из header)
    // → loadFromPgn(parseAnnotatedPgn(pgn)). makeVariantMove стартует Chess
    // из state.currentMove?.fen ?? state.initialFen, поэтому без
    // setInitialFen movе h7→h6 был бы нелегален (стандартный старт,
    // ход белых).
    const fen = 'r1bqkb1r/pp3ppp/2n2n2/2pp4/3P4/2N1PN2/PP3PPP/R1BQKB1R b KQkq - 0 25';
    const pgn = `[SetUp "1"]\n[FEN "${fen}"]\n\n25... a6 26. Bd3`;
    const moves = parseAnnotatedPgn(pgn);
    const { result } = renderHook(() => useReviewState());
    act(() => {
      result.current.setInitialFen(fen);
      result.current.loadFromPgn(moves);
    });

    expect(result.current.history[0].san).toBe('a6');
    expect(result.current.history[0].ply).toBe(50);

    act(() => {
      result.current.gotoFirst();
    });
    expect(result.current.currentMove).toBeNull();

    // Альтернатива чёрных в той же позиции, что и a6 — например, h6.
    act(() => {
      result.current.makeVariantMove('h7', 'h6');
    });

    const rootVar = result.current.history[0].variations;
    expect(rootVar).toBeDefined();
    expect(rootVar![0][0].san).toBe('h6');
    // Ключевое требование возврата: ply наследуется от history[0].
    expect(rootVar![0][0].ply).toBe(50);
    expect(rootVar![0][0].ply).toBe(result.current.history[0].ply);
  });

  it('повтор первого хода основной линии — не создаёт variation, переходит на history[0]', () => {
    const result = setupWithPgn('1. e4 e5 2. Nf3');
    const historyBefore = result.current.history;
    act(() => {
      result.current.gotoFirst();
    });

    // Играем тот же e4 — должны просто перейти на main-line e4.
    act(() => {
      result.current.makeVariantMove('e2', 'e4');
    });

    // История осталась той же (никаких новых ходов).
    expect(result.current.history).toBe(historyBefore);
    // Курсор — на main-line e4.
    expect(result.current.currentMove?.san).toBe('e4');
    expect(result.current.currentMove?.globalIndex).toBe(historyBefore[0].globalIndex);
    // Никаких variations не наросло.
    expect(result.current.history[0].variations).toBeUndefined();
  });

  it('пустая история + ход с root — обычный ADD_MOVE (не variation)', () => {
    const { result } = renderHook(() => useReviewState());
    expect(result.current.history).toEqual([]);
    expect(result.current.currentMove).toBeNull();

    act(() => {
      result.current.makeVariantMove('e2', 'e4');
    });

    expect(result.current.history.length).toBe(1);
    expect(result.current.history[0].san).toBe('e4');
    expect(result.current.history[0].variations).toBeUndefined();
    expect(result.current.currentMove?.san).toBe('e4');
  });

  it('повтор уже существующего root-variation — переключение на него, дубль не создаётся', () => {
    const result = setupWithPgn('1. e4 (1. d4) e5 2. Nf3');
    act(() => {
      result.current.gotoFirst();
    });

    const d4Before = result.current.history[0].variations![0][0];
    act(() => {
      result.current.makeVariantMove('d2', 'd4');
    });

    // Variations осталась одна (никаких дублей).
    expect(result.current.history[0].variations!.length).toBe(1);
    // Курсор стоит на существующем d4.
    expect(result.current.currentMove?.globalIndex).toBe(d4Before.globalIndex);
  });

  it('удаление root-variation — основная линия сохранена', () => {
    const result = setupWithPgn('1. e4 e5 2. Nf3');
    act(() => {
      result.current.gotoFirst();
    });
    act(() => {
      result.current.makeVariantMove('d2', 'd4');
    });
    const d4 = result.current.history[0].variations![0][0];

    act(() => {
      result.current.removeVariation(d4);
    });

    // Variations исчезли, основная линия не пострадала.
    expect(result.current.history[0].variations).toBeUndefined();
    expect(result.current.history.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3']);
  });
});
