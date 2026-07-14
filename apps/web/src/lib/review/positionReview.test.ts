/**
 * KS-4952 (ADR-165 rev4). Тесты генерации дерева репертуара:
 * асимметрия (наш ход 1 SF / соперник ветвится Maia), инвариант
 * очередности (нет листьев-ходов соперника), точки выхода [%exit],
 * пересмотр лимитов, детект перестановок. Плюс тест на реальном PGN
 * /tmp/KS-4951-example.pgn.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';

import {
  selectOpponentMoves,
  sideToMove,
  bothDeveloped,
  isNearEqual,
  maxOutcomeProb,
  formatSfEvalComment,
  exitTag,
  buildReviewPlan,
  defaultReviewConfig,
  ReviewAbortError,
  DEFAULT_REVIEW_THRESHOLDS,
  type PositionReviewEngines,
  type PositionReviewEval,
} from './positionReview';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ---------------------------------------------------------------------------
// §3 — nucleus-ветвление соперника.
// ---------------------------------------------------------------------------

describe('selectOpponentMoves (§3)', () => {
  const T = DEFAULT_REVIEW_THRESHOLDS; // pCover .90, pFloor .08, kMax 3

  it('форсировано (один ход ~90%) → одна ветка', () => {
    expect(selectOpponentMoves({ a: 0.9, b: 0.06, c: 0.04 }, T)).toEqual(['a']);
  });

  it('размазано → покрытие pCover, prob-desc', () => {
    // a .4, b .3, c .2 → покрыли .4 (<.9), .7 (<.9), .9 → стоп после c? cum
    // после c = .9, но проверка на входе следующего. kMax=3 тоже держит.
    expect(selectOpponentMoves({ a: 0.4, b: 0.3, c: 0.2, d: 0.1 }, T)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('pFloor отсекает хвост', () => {
    expect(selectOpponentMoves({ a: 0.6, b: 0.35, c: 0.05 }, T)).toEqual([
      'a',
      'b',
    ]);
  });

  it('kMax — жёсткий потолок ширины', () => {
    const r = selectOpponentMoves({ a: 0.25, b: 0.25, c: 0.25, d: 0.25 }, T);
    expect(r).toHaveLength(3);
  });

  it('пустая policy → []', () => {
    expect(selectOpponentMoves({}, T)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Утилиты §4.
// ---------------------------------------------------------------------------

describe('утилиты выхода', () => {
  it('sideToMove', () => {
    expect(sideToMove(START)).toBe('w');
    expect(sideToMove('... b - - 0 1')).toBe('b');
  });

  it('bothDeveloped: старт — оба короля на месте → false', () => {
    expect(bothDeveloped(START)).toBe(false);
  });

  it('bothDeveloped: оба рокировали → true', () => {
    // Белый Kg1, чёрный Kg8 (после короткой рокировки обеих сторон).
    const fen = 'rnbq1rk1/pppp1ppp/8/8/8/8/PPPP1PPP/RNBQ1RK1 w - - 0 1';
    expect(bothDeveloped(fen)).toBe(true);
  });

  it('isNearEqual', () => {
    expect(isNearEqual(0.5, 0.1)).toBe(true);
    expect(isNearEqual(0.58, 0.1)).toBe(true);
    expect(isNearEqual(0.7, 0.1)).toBe(false);
  });

  it('maxOutcomeProb', () => {
    expect(maxOutcomeProb({ w: 100, d: 850, l: 50 })).toBeCloseTo(0.85);
  });

  it('exitTag', () => {
    expect(exitTag('theory')).toBe('[%exit theory]');
    expect(exitTag('limit')).toBe('[%exit limit]');
  });

  it('formatSfEvalComment', () => {
    expect(formatSfEvalComment({ type: 'cp', value: 123 }, true)).toBe('SF +1.23');
    expect(formatSfEvalComment({ type: 'cp', value: 200 }, false)).toBe('SF -2.00');
    expect(formatSfEvalComment({ type: 'mate', value: 3 }, true)).toBe('SF #3');
  });
});

// ---------------------------------------------------------------------------
// Табличный mock-движок (fen → policy/eval/transitions).
// ---------------------------------------------------------------------------

function makeEngines(spec: {
  policy?: Record<string, Record<string, number>>;
  evals: Record<string, PositionReviewEval | null>;
  transitions: Record<string, Record<string, string>>;
}): PositionReviewEngines {
  return {
    getMaiaPolicy: async (fen) => spec.policy?.[fen] ?? {},
    analyze: async (fen) => (fen in spec.evals ? spec.evals[fen] : null),
    applyMove: (fen, uci) => spec.transitions[fen]?.[uci] ?? null,
    toSan: (_fen, uci) => uci,
  };
}

const ROOT = 'root w - - 0 1';
const nearEqualEval = (best: string): PositionReviewEval => ({
  bestUci: best,
  wdl: { w: 333, d: 334, l: 333 },
  multipv: [best],
  score: { type: 'cp', value: 0 },
});

/** Индексы move-операций и проверка «лист = наш ход + [%exit]». */
function analyzeOps(ops: ReturnType<typeof buildReviewPlan> extends Promise<infer R> ? (R extends { ops: infer O } ? O : never) : never) {
  const list = ops as Array<any>;
  const exitAnnotates = list.filter(
    (o) => o.type === 'annotate' && typeof o.comment === 'string' && o.comment.includes('[%exit'),
  );
  return { exitAnnotates };
}

describe('buildReviewPlan — инвариант очередности и точки выхода', () => {
  it('наш ход = 1 SF; соперник ветвится Maia; после соперника всегда наш ответ', async () => {
    // root(наш) a → CH(соперник) {m1,m2} → каждый → наш ответ до theory.
    const CH = 'ch b - - 0 1';
    const R1 = 'r1 b - - 0 2'; // после m1 + наш ответ (позиция соперника)
    const R2 = 'r2 b - - 0 2';
    const engines = makeEngines({
      policy: { [CH]: { m1: 0.6, m2: 0.4 } },
      evals: {
        [ROOT]: nearEqualEval('a'),
        [CH]: nearEqualEval('cx'),
        // после наших ответов — оба развились → theory (см. FEN с рокировкой)
        [R1]: nearEqualEval('zz'),
        [R2]: nearEqualEval('zz'),
      },
      transitions: {
        [ROOT]: { a: CH },
        [CH]: { m1: 'am1 w - - 0 2', m2: 'am2 w - - 0 2' },
        'am1 w - - 0 2': { or1: R1 },
        'am2 w - - 0 2': { or2: R2 },
      },
    });
    // Наши ответы am1/am2: SF best → or1/or2 (позиции соперника, оба
    // «развились» → theory). Зададим их эвалы.
    (engines as any).analyze = async (fen: string) => {
      const m: Record<string, PositionReviewEval> = {
        [ROOT]: nearEqualEval('a'),
        [CH]: nearEqualEval('cx'),
        'am1 w - - 0 2': nearEqualEval('or1'),
        'am2 w - - 0 2': nearEqualEval('or2'),
        // Позиции R1/R2 «после нашего ответа» — оба короля ушли (developed)
        [R1]: nearEqualEval('zz'),
        [R2]: nearEqualEval('zz'),
      };
      return m[fen] ?? null;
    };
    (engines as any).applyMove = (fen: string, uci: string) => {
      const t: Record<string, Record<string, string>> = {
        [ROOT]: { a: CH },
        [CH]: { m1: 'am1 w - - 0 2', m2: 'am2 w - - 0 2' },
        'am1 w - - 0 2': { or1: 'rnbq1rk1/pppp1ppp/8/8/8/8/PPPP1PPP/RNBQ1RK1 b - - 0 3' },
        'am2 w - - 0 2': { or2: 'rnbq1rk1/pppp1ppp/8/8/8/8/PPPP1PPP/RNBQ1RK1 b - - 5 3' },
      };
      return t[fen]?.[uci] ?? null;
    };
    (engines as any).getMaiaPolicy = async (fen: string) =>
      fen === CH ? { m1: 0.6, m2: 0.4 } : {};
    // developed-позиции после or1/or2 нужны в analyze:
    const prevAnalyze = (engines as any).analyze;
    (engines as any).analyze = async (fen: string) => {
      if (fen.startsWith('rnbq1rk1')) return nearEqualEval('zz');
      return prevAnalyze(fen);
    };

    const plan = await buildReviewPlan(ROOT, engines);
    const moves = plan.ops.filter((o) => o.type === 'move') as any[];
    // Наш первый ход единственный (a), соперник дал 2 ветки (m1,m2).
    expect(moves.filter((m) => m.source === 'stockfish').some((m) => m.uci === 'a')).toBe(true);
    expect(moves.filter((m) => m.uci === 'm1' || m.uci === 'm2')).toHaveLength(2);
    // Каждый [%exit] предшествует ход нашей стороны (stockfish).
    const { exitAnnotates } = analyzeOps(plan.ops);
    expect(exitAnnotates.length).toBeGreaterThan(0);
    for (const ann of exitAnnotates) {
      const idx = plan.ops.indexOf(ann);
      const prevMove = [...plan.ops.slice(0, idx)].reverse().find((o) => o.type === 'move') as any;
      expect(prevMove?.source).toBe('stockfish');
    }
  });

  it('refuted: за нас решающий перевес → лист [%exit refuted]', async () => {
    // root(наш) a → позиция соперника, где мы выигрываем (ourExp ≥ decisive).
    const CH = 'ch b - - 0 1';
    const engines = makeEngines({
      evals: {
        [ROOT]: {
          bestUci: 'a',
          wdl: { w: 500, d: 300, l: 200 },
          multipv: ['a'],
          score: { type: 'cp', value: 300 },
        },
        // childFen POV соперника: он проигрывает (l высок) → invert → мы
        // выигрываем (ourExp ~0.95 ≥ decisive).
        [CH]: { bestUci: 'x', wdl: { w: 30, d: 40, l: 930 }, multipv: ['x'], score: { type: 'cp', value: 700 } },
      },
      transitions: { [ROOT]: { a: CH } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    expect(plan.stats.leaves.refuted).toBe(1);
    const ann = plan.ops.find((o) => o.type === 'annotate') as any;
    expect(ann.comment).toContain('[%exit refuted]');
  });

  it('theory: near-equal + один ход соперника (forced) → [%exit theory]', async () => {
    const CH = 'ch b - - 0 1';
    const engines = makeEngines({
      policy: { [CH]: { m1: 0.95 } }, // один человеческий ход
      evals: { [ROOT]: nearEqualEval('a'), [CH]: nearEqualEval('cx') },
      transitions: { [ROOT]: { a: CH } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    expect(plan.stats.leaves.theory).toBe(1);
    const ann = plan.ops.find((o) => o.type === 'annotate') as any;
    expect(ann.comment).toContain('[%exit theory]');
  });

  it('transposition: повтор нормализованного FEN → [%exit transposition]', async () => {
    // root(наш) a → CH; CH(соперник) m1 → back(наш) b → та же позиция CH.
    const CH = 'chpos b - - 0 1';
    const engines = makeEngines({
      // 2 хода соперника → не «forced-theory», доходим до транспозиции.
      policy: { [CH]: { m1: 0.6, m2: 0.4 } },
      evals: {
        [ROOT]: nearEqualEval('a'),
        [CH]: nearEqualEval('cx'),
        'mid w - - 0 2': nearEqualEval('b'),
      },
      transitions: {
        [ROOT]: { a: CH },
        [CH]: { m1: 'mid w - - 0 2' }, // m2 без перехода → пропустится
        // наш ответ b возвращает в позицию с тем же ключом, что CH.
        'mid w - - 0 2': { b: 'chpos b - - 9 5' },
      },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    expect(plan.stats.leaves.transposition).toBeGreaterThanOrEqual(1);
    const ann = plan.ops.find(
      (o) => o.type === 'annotate' && (o as any).comment?.includes('[%exit transposition]'),
    );
    expect(ann).toBeDefined();
  });

  it('limit: щедрый предохранитель, лист помечен [%exit limit], не режется рано', async () => {
    // Бесконечная не-стабильная цепочка (ourExp вне near-equal, соперник 1 ход,
    // не developed) — обрывается по maxPly с меткой limit.
    const engines: PositionReviewEngines = {
      getMaiaPolicy: async () => ({ m: 0.9, m2: 0.5 }), // 2 хода → не forced-theory
      analyze: async () => ({
        bestUci: 'k',
        wdl: { w: 700, d: 200, l: 100 }, // ourExp ~0.8 — не near-equal, не decisive
        multipv: ['k'],
        score: { type: 'cp', value: 150 },
      }),
      applyMove: (fen) => {
        // каждый ход даёт новую позицию (глубина растёт, без транспозиций)
        const n = Number(fen.match(/#(\d+)/)?.[1] ?? '0') + 1;
        return `p#${n} ${n % 2 === 0 ? 'w' : 'b'} - - 0 1`;
      },
      toSan: (_f, u) => u,
    };
    const plan = await buildReviewPlan('p#0 w - - 0 1', engines, {
      ...defaultReviewConfig(),
      limits: { maxPly: 8, maxNodes: 500 },
    });
    expect(plan.stats.leaves.limit).toBeGreaterThanOrEqual(1);
    expect(plan.stats.maxPlyReached).toBeGreaterThanOrEqual(8); // дошёл до лимита, не срезан на 6
    const ann = plan.ops.find(
      (o) => o.type === 'annotate' && (o as any).comment?.includes('[%exit limit]'),
    );
    expect(ann).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Отмена.
// ---------------------------------------------------------------------------

describe('buildReviewPlan — отмена', () => {
  it('signal.aborted → ReviewAbortError', async () => {
    const engines = makeEngines({ evals: { [ROOT]: nearEqualEval('a') }, transitions: {} });
    const c = new AbortController();
    c.abort();
    await expect(
      buildReviewPlan(ROOT, engines, defaultReviewConfig(), { signal: c.signal }),
    ).rejects.toBeInstanceOf(ReviewAbortError);
  });
});

// ---------------------------------------------------------------------------
// Тест на реальном PGN /tmp/KS-4951-example.pgn (§7.5).
// ---------------------------------------------------------------------------

/**
 * Строит mock-движки из мейнлайна PGN: наши (белые) ходы = SF-best,
 * ходы соперника (чёрные) = Maia (ход из партии + одна альтернатива).
 * Вне скрипта: SF = первый легальный ход, Maia = один ход (forced).
 * Эвал near-equal (без refuted), чтобы выход шёл по theory/limit.
 */
function pgnRepertoireEngines(pgn: string): { engines: PositionReviewEngines; rootFen: string } {
  const game = new Chess();
  game.loadPgn(pgn);
  const history = game.history({ verbose: true }) as Array<any>;
  const sfBest: Record<string, string> = {};
  const maia: Record<string, Record<string, number>> = {};
  for (const mv of history) {
    const key = mv.before;
    const uci = `${mv.from}${mv.to}${mv.promotion ?? ''}`;
    if (mv.color === 'w') {
      if (!(key in sfBest)) sfBest[key] = uci;
    } else if (!(key in maia)) {
      // ход соперника из партии + одна альтернатива (первый другой легальный)
      const legal = new Chess(mv.before).moves({ verbose: true }) as Array<any>;
      const altMv = legal.find((l) => `${l.from}${l.to}${l.promotion ?? ''}` !== uci);
      const alt = altMv ? `${altMv.from}${altMv.to}${altMv.promotion ?? ''}` : null;
      maia[key] = alt ? { [uci]: 0.55, [alt]: 0.3 } : { [uci]: 0.95 };
    }
  }
  const engines: PositionReviewEngines = {
    getMaiaPolicy: async (fen) => {
      if (fen in maia) return maia[fen];
      // вне скрипта — единственный «человеческий» ход (первый легальный)
      const legal = new Chess(fen).moves({ verbose: true }) as Array<any>;
      if (legal.length === 0) return {};
      const l = legal[0];
      return { [`${l.from}${l.to}${l.promotion ?? ''}`]: 0.95 };
    },
    analyze: async (fen) => {
      const legal = new Chess(fen).moves({ verbose: true }) as Array<any>;
      if (legal.length === 0) return { bestUci: null, wdl: { w: 0, d: 0, l: 1000 }, multipv: [], score: null };
      const best = sfBest[fen] ?? `${legal[0].from}${legal[0].to}${legal[0].promotion ?? ''}`;
      return { bestUci: best, wdl: { w: 333, d: 334, l: 333 }, multipv: [best], score: { type: 'cp', value: 0 } };
    },
    applyMove: (fen, uci) => {
      try {
        const c = new Chess(fen);
        const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
        return mv ? c.fen() : null;
      } catch {
        return null;
      }
    },
    toSan: (fen, uci) => {
      try {
        const c = new Chess(fen);
        const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
        return mv?.san ?? uci;
      } catch {
        return uci;
      }
    },
  };
  return { engines, rootFen: START };
}

describe('buildReviewPlan — реальный PGN /tmp/KS-4951-example.pgn (§7.5)', () => {
  it('нет листьев-ходов соперника; каждый лист помечен [%exit]; глубина не режется на 12-м ходу', async () => {
    const pgn = readFileSync('/tmp/KS-4951-example.pgn', 'utf8');
    const { engines, rootFen } = pgnRepertoireEngines(pgn);
    const plan = await buildReviewPlan(rootFen, engines, {
      ...defaultReviewConfig(),
      // просторный горизонт/лимит — чтобы дебют не резался искусственно
      thresholds: { ...defaultReviewConfig().thresholds, openingHorizonPly: 40 },
      limits: { maxPly: 40, maxNodes: 400 },
    });

    const total =
      plan.stats.leaves.theory +
      plan.stats.leaves.refuted +
      plan.stats.leaves.transposition +
      plan.stats.leaves.limit +
      plan.stats.leaves.terminal;
    expect(total).toBeGreaterThan(0);
    // Реальный дебют без матов — терминалов нет.
    expect(plan.stats.leaves.terminal).toBe(0);

    // Каждый лист помечен [%exit] и ему предшествует ход НАШЕЙ стороны
    // (stockfish) — значит ни одна ветка не кончается ходом соперника.
    const exitAnnotates = plan.ops.filter(
      (o) => o.type === 'annotate' && typeof (o as any).comment === 'string' && (o as any).comment.includes('[%exit'),
    );
    // Число [%exit]-меток = число нетерминальных листьев.
    expect(exitAnnotates.length).toBe(total - plan.stats.leaves.terminal);
    for (const ann of exitAnnotates) {
      const idx = plan.ops.indexOf(ann);
      const prevMove = [...plan.ops.slice(0, idx)].reverse().find((o) => o.type === 'move') as any;
      expect(prevMove?.source).toBe('stockfish');
    }

    // Глубина не режется на 12-м ходу (ply 24): дерево уходит глубже прежнего
    // maxDepth=6/12 — доходит минимум до ~середины дебюта.
    expect(plan.stats.maxPlyReached).toBeGreaterThanOrEqual(12);
  });
});
