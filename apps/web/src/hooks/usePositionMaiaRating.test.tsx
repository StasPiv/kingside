/**
 * KS-3579. Тесты `usePositionMaiaRating` через мок-engine — без
 * реального ONNX worker'а.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  usePositionMaiaRating,
  POSITION_MAIA_RATINGS,
  selectFallbackMoves,
  type MaiaBatchEngine,
} from './usePositionMaiaRating';
import type { MovePrediction, PredictResult } from '../lib/maia/workerEngine';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function makeBatchResult(topMoves: string[]): PredictResult[] {
  return topMoves.map((move) => ({
    policy: [{ move, probability: 0.9 }],
    winProbability: 0.5,
  }));
}

/** Создаёт результат батча, где последний (топ-2400) — multi-policy
 *  с заданным набором ходов. Остальные батчи — moving "ne-stockfish".  */
function makeBatchResultWith2400Policy(
  notMatchedMove: string,
  topPolicyAt2400: MovePrediction[],
): PredictResult[] {
  const results: PredictResult[] = POSITION_MAIA_RATINGS.map(() => ({
    policy: [{ move: notMatchedMove, probability: 0.9 }],
    winProbability: 0.5,
  }));
  results[results.length - 1] = {
    policy: topPolicyAt2400,
    winProbability: 0.5,
  };
  return results;
}

describe('usePositionMaiaRating (KS-3579)', () => {
  it('начинается со status=idle', () => {
    const engine: MaiaBatchEngine = { predictMovesBatch: vi.fn() };
    const { result } = renderHook(() =>
      usePositionMaiaRating({ engine }),
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.rating).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('находит минимальный рейтинг, где top-1 Maia == stockfishBest', async () => {
    // Maia: до 1700 — e2e3, начиная с 1700 — e2e4.
    const topMoves = POSITION_MAIA_RATINGS.map((elo) =>
      elo >= 1700 ? 'e2e4' : 'e2e3',
    );
    const engine: MaiaBatchEngine = {
      predictMovesBatch: vi.fn().mockResolvedValue(makeBatchResult(topMoves)),
    };

    const { result } = renderHook(() => usePositionMaiaRating({ engine }));
    await act(async () => {
      await result.current.compute(STARTPOS, 'e2e4');
    });

    expect(result.current.status).toBe('done');
    expect(result.current.rating).toBe(1700);
    expect(engine.predictMovesBatch).toHaveBeenCalledWith(
      STARTPOS,
      [...POSITION_MAIA_RATINGS],
      [...POSITION_MAIA_RATINGS],
    );
  });

  it('возвращает above-range если top-1 Maia не совпал ни на одном ELO', async () => {
    const topMoves = POSITION_MAIA_RATINGS.map(() => 'e2e3');
    const engine: MaiaBatchEngine = {
      predictMovesBatch: vi.fn().mockResolvedValue(makeBatchResult(topMoves)),
    };

    const { result } = renderHook(() => usePositionMaiaRating({ engine }));
    await act(async () => {
      await result.current.compute(STARTPOS, 'e2e4');
    });

    expect(result.current.status).toBe('above-range');
    expect(result.current.rating).toBeNull();
  });

  // KS-3580 ------------------------------------------------------------

  it('KS-3580: при above-range кладёт topMoves от 2400 (топ-3 если все ≤ 10%)', async () => {
    // policy с распределением: 7% / 6% / 5% / 4% — топ-3 по правилу
    // «топ-3 или > 10%, что больше».
    const policyAt2400: MovePrediction[] = [
      { move: 'a2a3', probability: 0.07 },
      { move: 'b2b3', probability: 0.06 },
      { move: 'c2c3', probability: 0.05 },
      { move: 'd2d3', probability: 0.04 },
    ];
    const engine: MaiaBatchEngine = {
      predictMovesBatch: vi
        .fn()
        .mockResolvedValue(makeBatchResultWith2400Policy('e2e3', policyAt2400)),
    };
    const { result } = renderHook(() => usePositionMaiaRating({ engine }));
    await act(async () => {
      await result.current.compute(STARTPOS, 'e2e4');
    });
    expect(result.current.status).toBe('above-range');
    expect(result.current.topMoves.map((m) => m.move)).toEqual([
      'a2a3',
      'b2b3',
      'c2c3',
    ]);
  });

  it('KS-3580: при above-range отдаёт все ходы > 10% если их больше 3', async () => {
    const policyAt2400: MovePrediction[] = [
      { move: 'a2a3', probability: 0.3 },
      { move: 'b2b3', probability: 0.25 },
      { move: 'c2c3', probability: 0.2 },
      { move: 'd2d3', probability: 0.15 },
      { move: 'e2e3', probability: 0.05 },
    ];
    const engine: MaiaBatchEngine = {
      predictMovesBatch: vi
        .fn()
        .mockResolvedValue(makeBatchResultWith2400Policy('h2h3', policyAt2400)),
    };
    const { result } = renderHook(() => usePositionMaiaRating({ engine }));
    await act(async () => {
      await result.current.compute(STARTPOS, 'e2e4');
    });
    expect(result.current.status).toBe('above-range');
    expect(result.current.topMoves.map((m) => m.move)).toEqual([
      'a2a3',
      'b2b3',
      'c2c3',
      'd2d3',
    ]);
  });

  it('KS-3580: при done topMoves пустой (поведение штатного результата не меняется)', async () => {
    const topMoves = POSITION_MAIA_RATINGS.map((elo) =>
      elo >= 1700 ? 'e2e4' : 'e2e3',
    );
    const engine: MaiaBatchEngine = {
      predictMovesBatch: vi.fn().mockResolvedValue(makeBatchResult(topMoves)),
    };
    const { result } = renderHook(() => usePositionMaiaRating({ engine }));
    await act(async () => {
      await result.current.compute(STARTPOS, 'e2e4');
    });
    expect(result.current.status).toBe('done');
    expect(result.current.topMoves).toEqual([]);
  });

  it('KS-3580: selectFallbackMoves — топ-3 если все ниже 10%', () => {
    const policy: MovePrediction[] = [
      { move: 'a1', probability: 0.09 },
      { move: 'b1', probability: 0.08 },
      { move: 'c1', probability: 0.07 },
      { move: 'd1', probability: 0.06 },
    ];
    expect(selectFallbackMoves(policy).map((m) => m.move)).toEqual([
      'a1',
      'b1',
      'c1',
    ]);
  });

  it('KS-3580: selectFallbackMoves — все > 10% если их 4+', () => {
    const policy: MovePrediction[] = [
      { move: 'a1', probability: 0.3 },
      { move: 'b1', probability: 0.2 },
      { move: 'c1', probability: 0.15 },
      { move: 'd1', probability: 0.12 },
      { move: 'e1', probability: 0.05 },
    ];
    expect(selectFallbackMoves(policy).map((m) => m.move)).toEqual([
      'a1',
      'b1',
      'c1',
      'd1',
    ]);
  });

  it('error при падении engine', async () => {
    const engine: MaiaBatchEngine = {
      predictMovesBatch: vi.fn().mockRejectedValue(new Error('boom')),
    };

    const { result } = renderHook(() => usePositionMaiaRating({ engine }));
    await act(async () => {
      await result.current.compute(STARTPOS, 'e2e4');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('boom');
  });

  it('reset() возвращает в idle', async () => {
    const topMoves = POSITION_MAIA_RATINGS.map(() => 'e2e4');
    const engine: MaiaBatchEngine = {
      predictMovesBatch: vi.fn().mockResolvedValue(makeBatchResult(topMoves)),
    };

    const { result } = renderHook(() => usePositionMaiaRating({ engine }));
    await act(async () => {
      await result.current.compute(STARTPOS, 'e2e4');
    });
    expect(result.current.status).toBe('done');

    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
    expect(result.current.rating).toBeNull();
  });

  it('гард от устаревших ответов: вторая compute заглушает первую', async () => {
    // Первый вызов задерживается на 50 мс, второй мгновенный.
    let resolveFirst: (v: PredictResult[]) => void = () => undefined;
    const firstPromise = new Promise<PredictResult[]>((r) => {
      resolveFirst = r;
    });

    const engine: MaiaBatchEngine = {
      predictMovesBatch: vi
        .fn()
        .mockImplementationOnce(() => firstPromise)
        .mockResolvedValueOnce(
          makeBatchResult(POSITION_MAIA_RATINGS.map(() => 'd2d4')),
        ),
    };

    const { result } = renderHook(() => usePositionMaiaRating({ engine }));

    // Старт первого (висящего).
    let firstPromiseResult: Promise<void> | null = null;
    act(() => {
      firstPromiseResult = result.current.compute(STARTPOS, 'e2e4');
    });
    expect(result.current.status).toBe('computing');

    // Второй вызов — успевает завершиться раньше.
    await act(async () => {
      await result.current.compute(STARTPOS, 'd2d4');
    });
    expect(result.current.status).toBe('done');
    expect(result.current.rating).toBe(POSITION_MAIA_RATINGS[0]);

    // Резолвим первый — он НЕ должен затереть state.
    await act(async () => {
      resolveFirst(
        makeBatchResult(POSITION_MAIA_RATINGS.map(() => 'e2e4')),
      );
      await firstPromiseResult;
    });
    expect(result.current.status).toBe('done');
    expect(result.current.rating).toBe(POSITION_MAIA_RATINGS[0]);
  });
});
