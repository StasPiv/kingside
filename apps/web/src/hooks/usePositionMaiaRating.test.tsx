/**
 * KS-3579. Тесты `usePositionMaiaRating` через мок-engine — без
 * реального ONNX worker'а.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  usePositionMaiaRating,
  POSITION_MAIA_RATINGS,
  type MaiaBatchEngine,
} from './usePositionMaiaRating';
import type { PredictResult } from '../lib/maia/workerEngine';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function makeBatchResult(topMoves: string[]): PredictResult[] {
  return topMoves.map((move) => ({
    policy: [{ move, probability: 0.9 }],
    winProbability: 0.5,
  }));
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
