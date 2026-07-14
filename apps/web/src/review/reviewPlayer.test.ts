/**
 * KS-4944 (ADR-165 §5-§6). Unit-тесты чистой логики ReviewPlayer:
 * UCI-парсинг, тайминги/скорость, поиск узла, применение операций,
 * прогресс.
 */
import { describe, it, expect } from 'vitest';

import {
  parseUci,
  holdMsForOp,
  effectiveHoldMs,
  clampReviewSpeed,
  DEFAULT_REVIEW_TIMINGS,
  findMoveByGlobalIndex,
  applyReviewOp,
  totalReviewNodes,
  reviewProgress,
  type ReviewPlayerReviewApi,
  type ApplyOpContext,
} from './reviewPlayer';
import { REVIEW_ROOT_ID, type ReviewPlan, type ReviewPlanOp } from '../lib/review/positionReview';
import type { ChessMove } from './types';

// ---------------------------------------------------------------------------
// UCI / тайминги.
// ---------------------------------------------------------------------------

describe('parseUci', () => {
  it('обычный ход', () => {
    expect(parseUci('e2e4')).toEqual({ from: 'e2', to: 'e4', promotion: undefined });
  });
  it('промоция', () => {
    expect(parseUci('e7e8q')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
  });
  it('мусор → null', () => {
    expect(parseUci('e2')).toBeNull();
    expect(parseUci('')).toBeNull();
  });
});

describe('holdMsForOp / effectiveHoldMs (§6)', () => {
  const T = DEFAULT_REVIEW_TIMINGS; // animate 220, holdMove 900, holdKey 1800, reset 0

  it('move = animate + holdMove', () => {
    expect(holdMsForOp({ type: 'move', id: 0, uci: 'e2e4', san: 'e4', source: 'maia', wdlAfter: null }, T)).toBe(
      1120,
    );
  });
  it('annotate = holdKey', () => {
    expect(holdMsForOp({ type: 'annotate', nag: 2 }, T)).toBe(1800);
  });
  it('goto = reset', () => {
    expect(holdMsForOp({ type: 'goto', toId: 0 }, T)).toBe(0);
  });
  it('reduced-motion обнуляет слайд', () => {
    expect(
      holdMsForOp({ type: 'move', id: 0, uci: 'e2e4', san: 'e4', source: 'maia', wdlAfter: null }, T, true),
    ).toBe(900);
  });
  it('множитель скорости делит паузу', () => {
    expect(effectiveHoldMs(1000, 2)).toBe(500);
    expect(effectiveHoldMs(1000, 0.5)).toBe(2000);
  });
  it('скорость клампится в [0.5, 2]', () => {
    expect(clampReviewSpeed(5)).toBe(2);
    expect(clampReviewSpeed(0.1)).toBe(0.5);
    expect(clampReviewSpeed(0)).toBe(1);
    expect(clampReviewSpeed(NaN)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Поиск узла по globalIndex.
// ---------------------------------------------------------------------------

function node(globalIndex: number, extra: Partial<ChessMove> = {}): ChessMove {
  return {
    san: `m${globalIndex}`,
    fen: `fen${globalIndex}`,
    from: 'a1',
    to: 'a2',
    piece: 'p',
    flags: '',
    lan: 'a1a2',
    before: '',
    after: '',
    globalIndex,
    ply: globalIndex,
    ...extra,
  } as ChessMove;
}

describe('findMoveByGlobalIndex', () => {
  it('находит в основной линии по next', () => {
    const n0 = node(0);
    const n1 = node(1);
    n0.next = n1;
    expect(findMoveByGlobalIndex([n0], 1)).toBe(n1);
  });
  it('находит внутри вариации', () => {
    const n0 = node(0);
    const v = node(5);
    n0.variations = [[v]];
    expect(findMoveByGlobalIndex([n0], 5)).toBe(v);
  });
  it('нет узла → null', () => {
    expect(findMoveByGlobalIndex([node(0)], 99)).toBeNull();
  });
  it('циклическая ссылка не зацикливает', () => {
    const a = node(0);
    const b = node(1);
    a.next = b;
    b.next = a; // цикл
    expect(findMoveByGlobalIndex([a], 42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyReviewOp.
// ---------------------------------------------------------------------------

function makeFakeReview(opts: {
  history?: ChessMove[];
  currentGlobalIndex?: number;
  currentFen?: string;
}): {
  api: ReviewPlayerReviewApi;
  calls: {
    makeVariantMove: Array<[string, string, string | undefined]>;
    gotoMove: ChessMove[];
    gotoFirst: number;
    setNag: Array<[number, number[]]>;
    setComment: Array<[number, string]>;
  };
} {
  const calls = {
    makeVariantMove: [] as Array<[string, string, string | undefined]>,
    gotoMove: [] as ChessMove[],
    gotoFirst: 0,
    setNag: [] as Array<[number, number[]]>,
    setComment: [] as Array<[number, string]>,
  };
  const api: ReviewPlayerReviewApi = {
    makeVariantMove: (f, t, p) => {
      calls.makeVariantMove.push([f, t, p]);
      return true;
    },
    gotoMove: (m) => {
      calls.gotoMove.push(m);
    },
    gotoFirst: () => {
      calls.gotoFirst += 1;
    },
    setNag: (gi, n) => {
      calls.setNag.push([gi, n]);
    },
    setComment: (gi, c) => {
      calls.setComment.push([gi, c]);
    },
    getHistory: () => opts.history ?? [],
    getCurrentGlobalIndex: () => opts.currentGlobalIndex ?? -1,
    getCurrentFen: () => opts.currentFen ?? '',
  };
  return { api, calls };
}

const ROOT = 'root w - - 0 1';

describe('applyReviewOp', () => {
  it('move → makeVariantMove с распарсенным UCI', () => {
    const { api, calls } = makeFakeReview({});
    const ctx: ApplyOpContext = { idIndex: new Map() };
    const op: ReviewPlanOp = { type: 'move', id: 0, uci: 'e7e8q', san: 'e8=Q', source: 'stockfish', wdlAfter: null };
    expect(applyReviewOp(op, api, ctx)).toBe(true);
    expect(calls.makeVariantMove).toEqual([['e7', 'e8', 'q']]);
  });

  it('goto к корню без rootGlobalIndex → gotoFirst (стартовая позиция)', () => {
    const { api, calls } = makeFakeReview({});
    const ctx: ApplyOpContext = { idIndex: new Map() };
    const op: ReviewPlanOp = { type: 'goto', toId: REVIEW_ROOT_ID };
    expect(applyReviewOp(op, api, ctx)).toBe(true);
    expect(calls.gotoFirst).toBe(1);
  });

  it('KS-4950: goto к корню с rootGlobalIndex → gotoMove на узел запуска, не в начало', () => {
    const launch = node(12);
    const { api, calls } = makeFakeReview({ history: [launch] });
    const ctx: ApplyOpContext = { idIndex: new Map(), rootGlobalIndex: 12 };
    expect(applyReviewOp({ type: 'goto', toId: REVIEW_ROOT_ID }, api, ctx)).toBe(true);
    expect(calls.gotoMove).toEqual([launch]); // вернулись к текущей позиции
    expect(calls.gotoFirst).toBe(0); // НЕ в начало партии
  });

  it('KS-4950: rootGlobalIndex=-1 (запуск со старта) → gotoFirst', () => {
    const { api, calls } = makeFakeReview({});
    const ctx: ApplyOpContext = { idIndex: new Map(), rootGlobalIndex: -1 };
    expect(applyReviewOp({ type: 'goto', toId: REVIEW_ROOT_ID }, api, ctx)).toBe(true);
    expect(calls.gotoFirst).toBe(1);
  });

  it('goto к развилке → поиск узла по idIndex и gotoMove', () => {
    const fork = node(7);
    const { api, calls } = makeFakeReview({ history: [fork] });
    const idIndex = new Map<number, number>();
    idIndex.set(3, 7); // узел плана #3 → globalIndex 7
    const ctx: ApplyOpContext = { idIndex };
    const op: ReviewPlanOp = { type: 'goto', toId: 3 };
    expect(applyReviewOp(op, api, ctx)).toBe(true);
    expect(calls.gotoMove).toEqual([fork]);
  });

  it('KS-4950: транспозиция — узлы с одинаковой позицией, goto по id ведёт к нужному', () => {
    // Два узла имеют одинаковый FEN (транспозиция), но разные globalIndex.
    // Навигация по id обязана вернуть РОВНО тот узел, что записан для id,
    // а не «последний с этим FEN» (как было бы при поиске по FEN).
    const early = node(4, { fen: 'same w - - 0 5' });
    const late = node(9, { fen: 'same w - - 0 12' });
    const { api, calls } = makeFakeReview({ history: [early, late] });
    const idIndex = new Map<number, number>();
    idIndex.set(2, 4); // узел плана #2 → ранний
    idIndex.set(7, 9); // узел плана #7 → поздний
    const ctx: ApplyOpContext = { idIndex };
    expect(applyReviewOp({ type: 'goto', toId: 2 }, api, ctx)).toBe(true);
    expect(applyReviewOp({ type: 'goto', toId: 7 }, api, ctx)).toBe(true);
    expect(calls.gotoMove).toEqual([early, late]); // каждый id → свой узел
  });

  it('goto к неизвестной развилке → false, без навигации', () => {
    const { api, calls } = makeFakeReview({ history: [] });
    const ctx: ApplyOpContext = { idIndex: new Map() };
    expect(applyReviewOp({ type: 'goto', toId: 99 }, api, ctx)).toBe(false);
    expect(calls.gotoMove).toHaveLength(0);
    expect(calls.gotoFirst).toBe(0);
  });

  it('annotate → setNag + setComment на текущем узле', () => {
    const { api, calls } = makeFakeReview({ currentGlobalIndex: 3 });
    const ctx: ApplyOpContext = { idIndex: new Map() };
    const op: ReviewPlanOp = { type: 'annotate', nag: 4, comment: 'e5 (Maia 40%, 90%)' };
    expect(applyReviewOp(op, api, ctx)).toBe(true);
    expect(calls.setNag).toEqual([[3, [4]]]);
    expect(calls.setComment).toEqual([[3, 'e5 (Maia 40%, 90%)']]);
  });

  it('annotate без текущего узла (index -1) → false', () => {
    const { api, calls } = makeFakeReview({ currentGlobalIndex: -1 });
    const ctx: ApplyOpContext = { idIndex: new Map() };
    expect(applyReviewOp({ type: 'annotate', nag: 2 }, api, ctx)).toBe(false);
    expect(calls.setNag).toHaveLength(0);
  });

  it('move с битым UCI → false, makeVariantMove не вызывается', () => {
    const { api, calls } = makeFakeReview({});
    const ctx: ApplyOpContext = { idIndex: new Map() };
    const op = { type: 'move', id: 0, uci: 'e2', san: '?', source: 'maia', wdlAfter: null } as ReviewPlanOp;
    expect(applyReviewOp(op, api, ctx)).toBe(false);
    expect(calls.makeVariantMove).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Прогресс.
// ---------------------------------------------------------------------------

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

describe('reviewProgress / totalReviewNodes', () => {
  const plan = planWith([
    { type: 'goto', toId: REVIEW_ROOT_ID },
    { type: 'move', id: 0, uci: 'e2e4', san: 'e4', source: 'maia', wdlAfter: null },
    { type: 'annotate', nag: 2 },
    { type: 'goto', toId: REVIEW_ROOT_ID },
    { type: 'move', id: 1, uci: 'd2d4', san: 'd4', source: 'stockfish', wdlAfter: null },
  ]);

  it('total = число move-операций', () => {
    expect(totalReviewNodes(plan)).toBe(2);
  });

  it('current растёт только на move-операциях', () => {
    expect(reviewProgress(plan, -1)).toEqual({ current: 0, total: 2 });
    expect(reviewProgress(plan, 1)).toEqual({ current: 1, total: 2 }); // после первого move
    expect(reviewProgress(plan, 2)).toEqual({ current: 1, total: 2 }); // annotate не считается
    expect(reviewProgress(plan, 4)).toEqual({ current: 2, total: 2 }); // после второго move
  });
});
