/**
 * KS-4944 (ADR-165). Тест хука useReviewPlayer: пошаговый режим
 * (reduced-motion) применяет операции плана к review-actions, управление
 * статусом play/pause, прогресс, блокировка ручного ввода.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useReviewPlayer, type ReviewPlayerReviewState } from './useReviewPlayer';
import { REVIEW_ROOT_ID, type ReviewPlan, type ReviewPlanOp } from '../lib/review/positionReview';
import type { ChessMove } from '../review/types';

const ROOT = 'root w - - 0 1';

function planWith(ops: ReviewPlanOp[]): ReviewPlan {
  return {
    rootFen: ROOT,
    elo: 1500,
    ops,
    stats: {
      nodes: 0,
      leaves: { understood: 0, max_depth: 0, max_nodes: 0, repetition: 0, terminal: 0 },
      maxDepthReached: 0,
      truncatedByNodes: false,
      degradedNoSf: false,
    },
  };
}

/** Stateful-фейк useReviewState: пишет узлы синхронно, ведёт currentMove. */
function makeStatefulReview(): {
  review: ReviewPlayerReviewState;
  calls: {
    makeVariantMove: Array<[string, string, string | undefined]>;
    setNag: Array<[number, number[]]>;
    gotoFirst: number;
  };
} {
  const history: ChessMove[] = [];
  let current: ChessMove | null = null;
  let nextGi = 0;
  const calls = {
    makeVariantMove: [] as Array<[string, string, string | undefined]>,
    setNag: [] as Array<[number, number[]]>,
    gotoFirst: 0,
  };
  const review: ReviewPlayerReviewState = {
    makeVariantMove: (f, t, p) => {
      calls.makeVariantMove.push([f, t, p]);
      const gi = nextGi++;
      const n = {
        san: `${f}${t}`,
        fen: `${f}${t}-pos w - - 0 1`,
        from: f,
        to: t,
        piece: 'p',
        flags: '',
        lan: `${f}${t}`,
        before: '',
        after: '',
        globalIndex: gi,
        ply: gi,
        previous: current,
      } as ChessMove;
      if (current) current.next = n;
      else history.push(n);
      current = n;
      return true;
    },
    gotoMove: (m) => {
      current = m;
    },
    gotoFirst: () => {
      calls.gotoFirst += 1;
      current = null;
    },
    setNag: (gi, n) => {
      calls.setNag.push([gi, n]);
    },
    setComment: () => {},
    promoteVariation: () => {},
    getHistory: () => history,
    getCurrentGlobalIndex: () => (current ? current.globalIndex : -1),
    getCurrentFen: () => (current ? current.fen : ROOT),
    get currentMove() {
      return current;
    },
  };
  return { review, calls };
}

const PLAN = planWith([
  { type: 'goto', toId: REVIEW_ROOT_ID },
  { type: 'move', id: 0, uci: 'e2e4', san: 'e4', source: 'maia', wdlAfter: null },
  { type: 'annotate', nag: 2, comment: 'x' },
  { type: 'goto', toId: REVIEW_ROOT_ID },
  { type: 'move', id: 1, uci: 'd2d4', san: 'd4', source: 'stockfish', wdlAfter: null },
]);

describe('useReviewPlayer — пошаговый режим (reduced-motion)', () => {
  it('play = один шаг; операции ложатся в дерево, прогресс по move', () => {
    const { review, calls } = makeStatefulReview();
    const { result } = renderHook(() =>
      useReviewPlayer({ plan: PLAN, review, reducedMotion: true }),
    );

    expect(result.current.stepMode).toBe(true);
    expect(result.current.progress).toEqual({ current: 0, total: 2 });

    act(() => result.current.play()); // op0 goto ROOT
    expect(calls.gotoFirst).toBe(1);

    act(() => result.current.play()); // op1 move e2e4
    expect(calls.makeVariantMove).toEqual([['e2', 'e4', undefined]]);
    expect(result.current.progress).toEqual({ current: 1, total: 2 });

    act(() => result.current.play()); // op2 annotate
    expect(calls.setNag).toEqual([[0, [2]]]);

    act(() => result.current.play()); // op3 goto ROOT
    act(() => result.current.play()); // op4 move d2d4
    expect(calls.makeVariantMove).toEqual([
      ['e2', 'e4', undefined],
      ['d2', 'd4', undefined],
    ]);
    expect(result.current.progress).toEqual({ current: 2, total: 2 });
  });

  it('step применяет одну операцию независимо от статуса', () => {
    const { review, calls } = makeStatefulReview();
    const { result } = renderHook(() =>
      useReviewPlayer({ plan: PLAN, review, reducedMotion: true }),
    );
    act(() => result.current.step()); // op0 goto
    act(() => result.current.step()); // op1 move
    expect(calls.makeVariantMove).toHaveLength(1);
    expect(result.current.opIndex).toBe(1);
  });

  it('replay сбрасывает индекс и уводит в стартовую позицию', () => {
    const { review, calls } = makeStatefulReview();
    const { result } = renderHook(() =>
      useReviewPlayer({ plan: PLAN, review, reducedMotion: true }),
    );
    act(() => result.current.step());
    act(() => result.current.step());
    act(() => result.current.replay());
    expect(result.current.opIndex).toBe(-1);
    expect(result.current.status).toBe('idle');
    expect(calls.gotoFirst).toBeGreaterThanOrEqual(1);
  });
});

describe('useReviewPlayer — управление автопроигрыванием', () => {
  it('play переводит в playing и блокирует ручной ввод; pause снимает', () => {
    const { review } = makeStatefulReview();
    const { result } = renderHook(() =>
      useReviewPlayer({ plan: PLAN, review, reducedMotion: false }),
    );
    expect(result.current.isAutoplaying).toBe(false);

    act(() => result.current.play());
    expect(result.current.status).toBe('playing');
    expect(result.current.isAutoplaying).toBe(true);

    act(() => result.current.pause());
    expect(result.current.status).toBe('paused');
    expect(result.current.isAutoplaying).toBe(false);
  });

  it('setSpeed клампит множитель в [0.5, 2]', () => {
    const { review } = makeStatefulReview();
    const { result } = renderHook(() =>
      useReviewPlayer({ plan: PLAN, review, reducedMotion: false }),
    );
    act(() => result.current.setSpeed(10));
    expect(result.current.speed).toBe(2);
    act(() => result.current.setSpeed(0.1));
    expect(result.current.speed).toBe(0.5);
  });

  it('без плана управление безопасно (no-op)', () => {
    const { review } = makeStatefulReview();
    const { result } = renderHook(() =>
      useReviewPlayer({ plan: null, review, reducedMotion: false }),
    );
    act(() => result.current.play());
    expect(result.current.status).toBe('idle');
    expect(result.current.progress).toEqual({ current: 0, total: 0 });
  });
});
