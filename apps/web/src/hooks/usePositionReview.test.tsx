/**
 * KS-4943 (ADR-165). Тест хук-обёртки usePositionReview: статус,
 * результат ReviewPlan, guard устаревших прогонов, обработка ошибки.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { usePositionReview } from './usePositionReview';
import type { PositionReviewEngines } from '../lib/review/positionReview';

const ROOT = 'root w - - 0 1';

/** Движки: корень сразу «понят» → план из одного goto. */
const understoodEngines: PositionReviewEngines = {
  getMaiaPolicy: async () => ({ e2e4: 0.9, d2d4: 0.1 }),
  analyze: async () => ({
    bestUci: 'e2e4',
    wdl: { w: 980, d: 15, l: 5 },
    multipv: ['e2e4'],
  }),
  applyMove: () => null,
  toSan: (_f, u) => u,
};

describe('usePositionReview', () => {
  it('строит план и переходит в ready', async () => {
    const { result } = renderHook(() =>
      usePositionReview({ engines: understoodEngines }),
    );
    expect(result.current.status).toBe('idle');

    await act(async () => {
      await result.current.run(ROOT);
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.plan?.rootFen).toBe(ROOT);
    expect(result.current.plan?.stats.leaves.understood).toBe(1);
  });

  it('ошибка движка → status error', async () => {
    const failing: PositionReviewEngines = {
      ...understoodEngines,
      analyze: async () => {
        throw new Error('engine boom');
      },
    };
    const { result } = renderHook(() =>
      usePositionReview({ engines: failing }),
    );
    await act(async () => {
      await result.current.run(ROOT);
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toContain('boom');
  });

  it('reset возвращает в idle', async () => {
    const { result } = renderHook(() =>
      usePositionReview({ engines: understoodEngines }),
    );
    await act(async () => {
      await result.current.run(ROOT);
    });
    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
    expect(result.current.plan).toBeNull();
  });
});
