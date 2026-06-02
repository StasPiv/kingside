/**
 * KS-3603 → KS-3607. Тесты `useGameReview` через mock `ReviewEngines`.
 * Новый shape — WDL-объекты вместо cp.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { Wdl } from '@kingside/shared';

import {
  useGameReview,
  type ReviewEngines,
  parsePgnPlies,
} from './useGameReview';

const PGN_3PLIES =
  '[Event "Test"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *\n';

const NEUTRAL: Wdl = { w: 500, d: 0, l: 500 };

function mockEngines(over: Partial<ReviewEngines> = {}): ReviewEngines {
  return {
    analyzeSf: vi.fn().mockResolvedValue({
      bestUci: 'e2e4',
      wdlBefore: NEUTRAL,
      wdlAfterBest: NEUTRAL,
      wdlAfterSecondBest: NEUTRAL,
      bestPv: ['e2e4', 'e7e5'],
      wdlByMove: { e2e4: NEUTRAL },
      legalMovesCount: 20,
    }),
    evalMove: vi.fn().mockResolvedValue(NEUTRAL),
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
    expect(out[0].playedUci).toBe('e2e4');
    expect(out[2].playedUci).toBe('g1f3');
  });

  it('возвращает [] для пустого PGN', () => {
    expect(parsePgnPlies('[Event "x"]\n\n*\n')).toEqual([]);
  });
});

describe('useGameReview', () => {
  it('idle на старте', () => {
    const { result } = renderHook(() =>
      useGameReview({ engines: mockEngines() }),
    );
    expect(result.current.status).toBe('idle');
  });

  it('done через все плыхи; annotations длиной = plies', async () => {
    const engines = mockEngines();
    const { result } = renderHook(() => useGameReview({ engines }));
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('done');
    expect(result.current.result?.annotations).toHaveLength(3);
    expect(engines.terminate).toHaveBeenCalled();
  });

  it('пустой PGN → error', async () => {
    const { result } = renderHook(() =>
      useGameReview({ engines: mockEngines() }),
    );
    await act(async () => {
      await result.current.run('[Event "x"]\n\n*\n');
    });
    expect(result.current.status).toBe('error');
  });

  it('error в engine → status=error + terminate', async () => {
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

  it('cancel в полёте → cancelled', async () => {
    let resolveFirst: () => void = () => undefined;
    const sfMock = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveFirst = () => {
            r({
              bestUci: 'e2e4',
              wdlBefore: NEUTRAL,
              wdlAfterBest: NEUTRAL,
              wdlAfterSecondBest: NEUTRAL,
              bestPv: ['e2e4'],
              wdlByMove: { e2e4: NEUTRAL },
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
    resolveFirst();
    await act(async () => {
      await runPromise;
    });
    expect(result.current.status).toBe('cancelled');
  });

  it('передаёт ELO в Maia и depth в SF', async () => {
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

  it('evalMove вызывается когда playedUci не в wdlByMove (top-3 без сыгранного)', async () => {
    const engines = mockEngines({
      analyzeSf: vi.fn().mockResolvedValue({
        bestUci: 'e2e4',
        wdlBefore: NEUTRAL,
        wdlAfterBest: NEUTRAL,
        wdlAfterSecondBest: NEUTRAL,
        bestPv: ['e2e4'],
        wdlByMove: { e2e4: NEUTRAL }, // нет e7e5 и g1f3
        legalMovesCount: 20,
      }),
    });
    const { result } = renderHook(() => useGameReview({ engines }));
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    // На 1. e4: playedUci=e2e4 — в wdlByMove → evalMove НЕ зовётся.
    // На 2. e5: playedUci=e7e5 — нет → evalMove зовётся.
    // На 3. Nf3: playedUci=g1f3 — нет → evalMove зовётся.
    expect(engines.evalMove).toHaveBeenCalledTimes(2);
  });

  it('reset() → idle', async () => {
    const engines = mockEngines();
    const { result } = renderHook(() => useGameReview({ engines }));
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('done');
    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
  });
});
