/**
 * KS-3584. Тесты `useMaiaAnalysis`: подбор initial ELO, debounce 250 мс,
 * запись в localStorage при смене ELO, error-path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/** flush microtasks (resolved promises) — нужно, чтобы Maia.then(…)
 *  внутри setTimeout-колбэка успел отработать после fake-timers. */
async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

import {
  useMaiaAnalysis,
  resolveInitialElo,
  MAIA_INTERNAL,
  type MaiaSinglePredictionEngine,
} from './useMaiaAnalysis';
import type { MovePrediction } from '../lib/maia/workerEngine';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function makeResult(moves: Array<[string, number]>): {
  policy: MovePrediction[];
  winProbability: number;
} {
  return {
    policy: moves.map(([move, probability]) => ({ move, probability })),
    winProbability: 0.5,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveInitialElo (KS-3584)', () => {
  it('из user.ratingBlitz, clamp в 1100..2400 шаг 100', () => {
    expect(
      resolveInitialElo({
        ratingBlitz: 1750,
        ratingRapid: 0,
        ratingClassical: 0,
        ratingBullet: 0,
      } as Parameters<typeof resolveInitialElo>[0]),
    ).toBe(1800); // 1750 → ближайшее кратное 100 = 1800
  });

  it('clamp выше 2400 → 2400', () => {
    expect(
      resolveInitialElo({
        ratingBlitz: 3200,
      } as Parameters<typeof resolveInitialElo>[0]),
    ).toBe(2400);
  });

  it('clamp ниже 1100 → 1100', () => {
    expect(
      resolveInitialElo({
        ratingBlitz: 600,
      } as Parameters<typeof resolveInitialElo>[0]),
    ).toBe(1100);
  });

  it('fallback на localStorage если нет user', () => {
    localStorage.setItem(MAIA_INTERNAL.STORAGE_KEY, '1900');
    expect(resolveInitialElo(null)).toBe(1900);
  });

  it('final fallback 1500 если нет ни user, ни localStorage', () => {
    expect(resolveInitialElo(null)).toBe(MAIA_INTERNAL.DEFAULT);
  });
});

describe('useMaiaAnalysis (KS-3584)', () => {
  it('первый прогон стартует с debounce 250 мс и отдаёт top-5', async () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi.fn().mockResolvedValue(
        makeResult([
          ['e2e4', 0.3],
          ['d2d4', 0.25],
          ['g1f3', 0.15],
          ['c2c4', 0.1],
          ['e2e3', 0.08],
          ['b2b3', 0.05],
        ]),
      ),
    };

    const { result } = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user: null, engine }),
    );

    // До истечения 250 мс — engine ещё не вызван.
    expect(result.current.status).toBe('loading');
    expect(engine.predictMoves).not.toHaveBeenCalled();

    // 200 мс — всё ещё нет.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(engine.predictMoves).not.toHaveBeenCalled();

    // 250 мс — пошёл.
    await act(async () => {
      vi.advanceTimersByTime(60);
      await flushPromises();
    });

    expect(result.current.status).toBe('ready');
    expect(engine.predictMoves).toHaveBeenCalledTimes(1);
    expect(engine.predictMoves).toHaveBeenCalledWith(STARTPOS, 1500, 1500);
    // top-5 ограничение.
    expect(result.current.lines).toHaveLength(5);
    expect(result.current.lines[0].move).toBe('e2e4');
  });

  it('debounce: быстрая смена fen приводит к одному прогону', async () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi.fn().mockResolvedValue(makeResult([['e2e4', 0.5]])),
    };

    const { rerender } = renderHook(
      (props: { fen: string }) =>
        useMaiaAnalysis({ fen: props.fen, user: null, engine }),
      { initialProps: { fen: STARTPOS } },
    );

    // Быстрые смены fen.
    rerender({ fen: 'f1' });
    rerender({ fen: 'f2' });
    rerender({ fen: 'f3' });

    await act(async () => {
      vi.advanceTimersByTime(300);
      await flushPromises();
    });

    // Только последняя смена должна выйти в прогон.
    expect(engine.predictMoves).toHaveBeenCalledTimes(1);
    expect(engine.predictMoves).toHaveBeenCalledWith('f3', 1500, 1500);
  });

  it('смена ELO сохраняет значение в localStorage', async () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi.fn().mockResolvedValue(makeResult([['e2e4', 0.5]])),
    };

    const { result } = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user: null, engine }),
    );

    act(() => {
      result.current.setElo(1900);
    });

    expect(localStorage.getItem(MAIA_INTERNAL.STORAGE_KEY)).toBe('1900');
    expect(result.current.elo).toBe(1900);
  });

  it('clamp при setElo: значение приводится к шкале 1100..2400 шаг 100', async () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi.fn().mockResolvedValue(makeResult([['e2e4', 0.5]])),
    };
    const { result } = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user: null, engine }),
    );
    act(() => result.current.setElo(1267));
    expect(result.current.elo).toBe(1300);
    act(() => result.current.setElo(99999));
    expect(result.current.elo).toBe(2400);
  });

  it('error при reject engine, retry() перезапускает прогон', async () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(makeResult([['e2e4', 0.4]])),
    };

    const { result } = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user: null, engine }),
    );

    await act(async () => {
      vi.advanceTimersByTime(300);
      await flushPromises();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('boom');

    act(() => result.current.retry());
    await act(async () => {
      vi.advanceTimersByTime(300);
      await flushPromises();
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.lines[0].move).toBe('e2e4');
  });

  it('initial ELO берётся из user.ratingBlitz если он есть', () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi.fn().mockResolvedValue(makeResult([['e2e4', 0.5]])),
    };
    const user = {
      ratingBlitz: 2050,
      ratingRapid: 1800,
      ratingClassical: 1700,
      ratingBullet: 1600,
    } as Parameters<typeof useMaiaAnalysis>[0]['user'];

    const { result } = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user, engine }),
    );
    expect(result.current.elo).toBe(2100); // 2050 → 2100
  });

  it('initial ELO: при отсутствии user берётся localStorage', () => {
    localStorage.setItem(MAIA_INTERNAL.STORAGE_KEY, '1700');
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi.fn().mockResolvedValue(makeResult([['e2e4', 0.5]])),
    };
    const { result } = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user: null, engine }),
    );
    expect(result.current.elo).toBe(1700);
  });
});
