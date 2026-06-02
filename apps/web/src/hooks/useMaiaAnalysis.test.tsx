/**
 * KS-3588 (ADR-097). Тесты `useMaiaAnalysis` после смены API:
 * `getProbability(uci)` вместо `lines[]`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  useMaiaAnalysis,
  resolveInitialElo,
  MAIA_INTERNAL,
  type MaiaSinglePredictionEngine,
} from './useMaiaAnalysis';
import type { MovePrediction } from '../lib/maia/workerEngine';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

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

describe('resolveInitialElo (KS-3588)', () => {
  it('из user.ratingBlitz, clamp в 1100..2400 шаг 100', () => {
    expect(
      resolveInitialElo({
        ratingBlitz: 1750,
        ratingRapid: 0,
        ratingClassical: 0,
        ratingBullet: 0,
      } as Parameters<typeof resolveInitialElo>[0]),
    ).toBe(1800);
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

  it('final fallback 1500 если ничего нет', () => {
    expect(resolveInitialElo(null)).toBe(MAIA_INTERNAL.DEFAULT);
  });
});

describe('useMaiaAnalysis (KS-3588)', () => {
  it('первый прогон стартует с debounce 250 мс и заполняет policyByMove', async () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi.fn().mockResolvedValue(
        makeResult([
          ['e2e4', 0.3],
          ['d2d4', 0.25],
          ['g1f3', 0.15],
        ]),
      ),
    };

    const { result } = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user: null, engine }),
    );

    expect(result.current.status).toBe('loading');
    expect(engine.predictMoves).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(engine.predictMoves).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(60);
      await flushPromises();
    });

    expect(result.current.status).toBe('ready');
    expect(engine.predictMoves).toHaveBeenCalledWith(STARTPOS, 1500, 1500);
    // getProbability lookup
    expect(result.current.getProbability('e2e4')).toBeCloseTo(0.3);
    expect(result.current.getProbability('g1f3')).toBeCloseTo(0.15);
    // Неизвестный ход → undefined.
    expect(result.current.getProbability('a2a4')).toBeUndefined();
    // Null/undefined вход → undefined.
    expect(result.current.getProbability(null)).toBeUndefined();
    expect(result.current.getProbability(undefined)).toBeUndefined();

    // KS-3597: policyByMove exposed.
    expect(result.current.policyByMove).toMatchObject({
      e2e4: expect.closeTo(0.3, 5),
      d2d4: expect.closeTo(0.25, 5),
      g1f3: expect.closeTo(0.15, 5),
    });
  });

  // KS-3597 ------------------------------------------------------------

  it('KS-3597: policyByMove пуст при status=idle/loading и error', async () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const { result } = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user: null, engine }),
    );
    // loading → пустой
    expect(result.current.status).toBe('loading');
    expect(result.current.policyByMove).toEqual({});

    await act(async () => {
      vi.advanceTimersByTime(300);
      await flushPromises();
    });
    // error → тоже пустой (на смену fen внутри useEffect мы делаем
    // setPolicyByMove({}), на reject — оставляем пустым).
    expect(result.current.status).toBe('error');
    expect(result.current.policyByMove).toEqual({});
  });

  it('KS-3597: смена fen → policyByMove обновляется на новую позицию', async () => {
    const FEN_2 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi
        .fn()
        .mockResolvedValueOnce(makeResult([['e2e4', 0.5]]))
        .mockResolvedValueOnce(makeResult([['e7e5', 0.6], ['c7c5', 0.2]])),
    };

    const { result, rerender } = renderHook(
      (props: { fen: string }) =>
        useMaiaAnalysis({ fen: props.fen, user: null, engine }),
      { initialProps: { fen: STARTPOS } },
    );
    await act(async () => {
      vi.advanceTimersByTime(300);
      await flushPromises();
    });
    expect(result.current.policyByMove).toEqual({ e2e4: 0.5 });

    rerender({ fen: FEN_2 });
    // На смену fen первое: useEffect → setPolicyByMove({}) → пустой
    expect(result.current.policyByMove).toEqual({});

    await act(async () => {
      vi.advanceTimersByTime(300);
      await flushPromises();
    });
    expect(result.current.policyByMove).toMatchObject({
      e7e5: expect.closeTo(0.6, 5),
      c7c5: expect.closeTo(0.2, 5),
    });
    expect('e2e4' in result.current.policyByMove).toBe(false);
  });

  it('debounce: 3 быстрых смены fen дают 1 прогон с последним fen', async () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi.fn().mockResolvedValue(makeResult([['e2e4', 0.5]])),
    };

    const { rerender } = renderHook(
      (props: { fen: string }) =>
        useMaiaAnalysis({ fen: props.fen, user: null, engine }),
      { initialProps: { fen: STARTPOS } },
    );
    rerender({ fen: 'f1' });
    rerender({ fen: 'f2' });
    rerender({ fen: 'f3' });

    await act(async () => {
      vi.advanceTimersByTime(300);
      await flushPromises();
    });

    expect(engine.predictMoves).toHaveBeenCalledTimes(1);
    expect(engine.predictMoves).toHaveBeenCalledWith('f3', 1500, 1500);
  });

  it('смена fen затирает старую policyByMove (placeholder вместо стейл-данных)', async () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi
        .fn()
        // FEN-1 → есть e2e4
        .mockResolvedValueOnce(makeResult([['e2e4', 0.5]]))
        // FEN-2 → пока висит, лукап e2e4 должен вернуть undefined
        .mockImplementation(() => new Promise(() => {})),
    };
    const { result, rerender } = renderHook(
      (props: { fen: string }) =>
        useMaiaAnalysis({ fen: props.fen, user: null, engine }),
      { initialProps: { fen: STARTPOS } },
    );
    await act(async () => {
      vi.advanceTimersByTime(300);
      await flushPromises();
    });
    expect(result.current.getProbability('e2e4')).toBeCloseTo(0.5);

    // Меняем FEN → policy очищается до прихода ответа.
    rerender({ fen: 'newfen' });
    expect(result.current.status).toBe('loading');
    expect(result.current.getProbability('e2e4')).toBeUndefined();
  });

  it('смена ELO пишет в localStorage и инициирует пересчёт', async () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi.fn().mockResolvedValue(makeResult([['e2e4', 0.5]])),
    };

    const { result } = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user: null, engine }),
    );

    await act(async () => {
      vi.advanceTimersByTime(300);
      await flushPromises();
    });
    expect(engine.predictMoves).toHaveBeenCalledTimes(1);

    act(() => result.current.setElo(1900));
    expect(localStorage.getItem(MAIA_INTERNAL.STORAGE_KEY)).toBe('1900');

    await act(async () => {
      vi.advanceTimersByTime(300);
      await flushPromises();
    });
    expect(engine.predictMoves).toHaveBeenCalledTimes(2);
    expect(engine.predictMoves).toHaveBeenLastCalledWith(STARTPOS, 1900, 1900);
  });

  it('clamp при setElo: 1267 → 1300, 99999 → 2400', () => {
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

  it('error при reject engine; retry() запускает повтор', async () => {
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
    expect(result.current.getProbability('e2e4')).toBeCloseTo(0.4);
  });

  it('initial ELO из user.ratingBlitz, иначе localStorage, иначе 1500', () => {
    const engine: MaiaSinglePredictionEngine = {
      predictMoves: vi.fn().mockResolvedValue(makeResult([['e2e4', 0.5]])),
    };

    // 1) user
    const u = {
      ratingBlitz: 2050,
      ratingRapid: 1800,
      ratingClassical: 1700,
      ratingBullet: 1600,
    } as Parameters<typeof useMaiaAnalysis>[0]['user'];
    const r1 = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user: u, engine }),
    );
    expect(r1.result.current.elo).toBe(2100);

    // 2) localStorage
    localStorage.setItem(MAIA_INTERNAL.STORAGE_KEY, '1700');
    const r2 = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user: null, engine }),
    );
    expect(r2.result.current.elo).toBe(1700);

    // 3) default
    localStorage.clear();
    const r3 = renderHook(() =>
      useMaiaAnalysis({ fen: STARTPOS, user: null, engine }),
    );
    expect(r3.result.current.elo).toBe(1500);
  });
});
