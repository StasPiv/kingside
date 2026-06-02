/**
 * KS-3603. Тесты `useGameReview` через mock `ReviewEngines`.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  useGameReview,
  type ReviewEngines,
  parsePgnPlies,
} from './useGameReview';

const PGN_3PLIES =
  '[Event "Test"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *\n';

function mockEngines(over: Partial<ReviewEngines> = {}): ReviewEngines {
  return {
    analyzeSf: vi.fn().mockResolvedValue({
      bestUci: 'e2e4',
      bestCp: 30,
      secondCp: 20,
      bestPv: ['e2e4', 'e7e5'],
      mateBefore: null,
      legalMovesCount: 20,
    }),
    evalAfter: vi.fn().mockResolvedValue({ cp: -30 }),
    predictMaia: vi.fn().mockResolvedValue({
      byUci: { e2e4: 0.4, d2d4: 0.2 },
      topUci: 'e2e4',
      topProb: 0.4,
    }),
    terminate: vi.fn(),
    ...over,
  };
}

describe('parsePgnPlies', () => {
  it('возвращает 3 полухода для PGN 1. e4 e5 2. Nf3', () => {
    const out = parsePgnPlies(PGN_3PLIES);
    expect(out).toHaveLength(3);
    expect(out[0].ply).toBe(1);
    expect(out[0].playedUci).toBe('e2e4');
    expect(out[1].playedUci).toBe('e7e5');
    expect(out[2].playedUci).toBe('g1f3');
  });

  it('возвращает [] для пустого PGN', () => {
    expect(parsePgnPlies('[Event "x"]\n\n*\n')).toEqual([]);
  });
});

describe('useGameReview', () => {
  it('начинается в status=idle', () => {
    const { result } = renderHook(() =>
      useGameReview({ engines: mockEngines() }),
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.progress).toEqual({ done: 0, total: 0 });
  });

  it('успешный прогон: status → running → done, annotations длиной = plies', async () => {
    const engines = mockEngines();
    const { result } = renderHook(() => useGameReview({ engines }));

    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });

    expect(result.current.status).toBe('done');
    expect(result.current.result?.annotations).toHaveLength(3);
    expect(result.current.progress).toEqual({ done: 3, total: 3 });
    expect(engines.terminate).toHaveBeenCalled();
  });

  it('пустой PGN → status=error', async () => {
    const { result } = renderHook(() =>
      useGameReview({ engines: mockEngines() }),
    );

    await act(async () => {
      await result.current.run('[Event "x"]\n\n*\n');
    });
    expect(result.current.status).toBe('error');
  });

  it('ошибка движка → status=error, terminate вызван', async () => {
    const engines = mockEngines({
      analyzeSf: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const { result } = renderHook(() => useGameReview({ engines }));
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('boom');
    expect(engines.terminate).toHaveBeenCalled();
  });

  it('cancel в полёте → status=cancelled, terminate вызван', async () => {
    // Эмулируем медленные ответы — controller resolve по нашему сигналу.
    let resolveFirst: () => void = () => undefined;
    const sfMock = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveFirst = () => {
            r({
              bestUci: 'e2e4',
              bestCp: 30,
              secondCp: 20,
              bestPv: ['e2e4'],
              mateBefore: null,
              legalMovesCount: 20,
            });
          };
        }),
    );
    const engines = mockEngines({ analyzeSf: sfMock });

    const { result } = renderHook(() => useGameReview({ engines }));
    let runPromise: Promise<void> | null = null;
    act(() => {
      runPromise = result.current.run(PGN_3PLIES);
    });
    await waitFor(() => expect(result.current.status).toBe('running'));

    act(() => result.current.cancel());
    // Разморозим первый ответ — должен сработать cancel-чек.
    resolveFirst();
    await act(async () => {
      await runPromise;
    });

    expect(result.current.status).toBe('cancelled');
    expect(engines.terminate).toHaveBeenCalled();
  });

  it('передаёт ELO в Maia', async () => {
    const engines = mockEngines();
    const { result } = renderHook(() =>
      useGameReview({ engines, elo: 1900, depth: 12 }),
    );
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(engines.predictMaia).toHaveBeenCalledWith(expect.any(String), 1900);
    expect(engines.analyzeSf).toHaveBeenCalledWith(
      expect.any(String),
      3,
      12,
    );
  });

  it('reset() возвращает в idle', async () => {
    const engines = mockEngines();
    const { result } = renderHook(() => useGameReview({ engines }));
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('done');
    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeUndefined();
  });
});
