/**
 * KS-4943 (ADR-165). Unit-тесты оркестратора usePositionReview:
 * пороги Maia §3.1, стоп-условие §4, аварийные лимиты §2, сборка плана.
 */
import { describe, it, expect } from 'vitest';
import type { Wdl } from '@kingside/shared';

import {
  selectMaiaCandidates,
  maiaTopMove,
  isUnderstood,
  maxOutcomeProb,
  nagForLossE,
  wdlFromCp,
  positionKey,
  unionCandidates,
  buildReviewPlan,
  defaultReviewConfig,
  formatSfEvalComment,
  ReviewAbortError,
  DEFAULT_REVIEW_THRESHOLDS,
  type PositionReviewEngines,
  type PositionReviewEval,
  type ReviewConfig,
} from './positionReview';

const W: Wdl = { w: 1000, d: 0, l: 0 }; // decided win, POV stm

// ---------------------------------------------------------------------------
// §3.1 — пороги Maia.
// ---------------------------------------------------------------------------

describe('selectMaiaCandidates (§3.1)', () => {
  const T = DEFAULT_REVIEW_THRESHOLDS; // pFloor .10, pNucleus .85, rel .4, nMax 2

  it('форсированная позиция (один ход ~90%) → один кандидат', () => {
    const policy = { e2e4: 0.9, d2d4: 0.05, g1f3: 0.03, b1c3: 0.02 };
    expect(selectMaiaCandidates(policy, T)).toEqual(['e2e4']);
  });

  it('спокойная позиция (размазано) → 1-2 кандидата по nMax', () => {
    const policy = { e2e4: 0.35, d2d4: 0.3, g1f3: 0.2, c2c4: 0.15 };
    expect(selectMaiaCandidates(policy, T)).toEqual(['e2e4', 'd2d4']);
  });

  it('абсолютный пол pFloor отсекает редкие ходы', () => {
    const policy = { e2e4: 0.5, d2d4: 0.08, g1f3: 0.42 };
    // d2d4=0.08 < pFloor 0.10 — но g1f3=0.42 идёт первым по сортировке.
    // Сортировка: e2e4 .5, g1f3 .42, d2d4 .08. rel floor = .4*.5=.2.
    // e2e4 ok; g1f3 .42≥.2 ok; nMax=2 → стоп. d2d4 не доходит.
    expect(selectMaiaCandidates(policy, T)).toEqual(['e2e4', 'g1f3']);
  });

  it('относительный пол rel·probTop отсекает хвост у главного хода', () => {
    const policy = { e2e4: 0.7, d2d4: 0.2, g1f3: 0.1 };
    // rel floor = .4*.7 = .28. d2d4=.2 < .28 → отсекается. Остаётся e2e4.
    expect(selectMaiaCandidates(policy, T)).toEqual(['e2e4']);
  });

  it('nMax ограничивает даже при широком ядре', () => {
    const policy = { a: 0.25, b: 0.25, c: 0.25, d: 0.25 };
    const res = selectMaiaCandidates(policy, { ...T, nMax: 3 });
    expect(res).toHaveLength(3);
  });

  it('пустая / нулевая policy → пустой список', () => {
    expect(selectMaiaCandidates({}, T)).toEqual([]);
    expect(selectMaiaCandidates({ e2e4: 0 }, T)).toEqual([]);
  });

  it('pNucleus обрывает добор за пределами ядра', () => {
    // top-p 0.85: первые два хода дают 0.6 (<0.85), третий начинается с
    // cumBefore 0.6 (<0.85) — тоже в ядре; но nMax=2 ограничит. Проверим
    // с nMax=5 и малым pNucleus.
    const policy = { a: 0.5, b: 0.1, c: 0.1, d: 0.1, e: 0.1 };
    // rel floor = .2 → только a проходит rel (b..e = .1 < .2). Стоп на b.
    expect(selectMaiaCandidates(policy, { ...T, nMax: 5 })).toEqual(['a']);
  });
});

describe('maiaTopMove', () => {
  it('возвращает argmax', () => {
    expect(maiaTopMove({ a: 0.2, b: 0.5, c: 0.3 })).toBe('b');
  });
  it('пустая policy → null', () => {
    expect(maiaTopMove({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4 — стоп-условие.
// ---------------------------------------------------------------------------

describe('isUnderstood (§4)', () => {
  it('SF-best == Maia-top И max WDL > 0.95 → понято', () => {
    expect(isUnderstood('e2e4', 'e2e4', { w: 970, d: 20, l: 10 }, 0.95)).toBe(
      true,
    );
  });

  it('ходы совпали, но исход не определён → не понято', () => {
    expect(isUnderstood('e2e4', 'e2e4', { w: 500, d: 300, l: 200 }, 0.95)).toBe(
      false,
    );
  });

  it('исход определён, но SF ≠ Maia → не понято (углубляемся)', () => {
    expect(isUnderstood('e2e4', 'd2d4', W, 0.95)).toBe(false);
  });

  it('SF недоступен (bestUci null) → не понято', () => {
    expect(isUnderstood('e2e4', null, W, 0.95)).toBe(false);
  });

  it('ничейный decided (D>0.95) тоже понято', () => {
    expect(isUnderstood('a', 'a', { w: 20, d: 970, l: 10 }, 0.95)).toBe(true);
  });
});

describe('maxOutcomeProb', () => {
  it('берёт максимальную из W/D/L компонент', () => {
    expect(maxOutcomeProb({ w: 100, d: 850, l: 50 })).toBeCloseTo(0.85);
  });
});

// ---------------------------------------------------------------------------
// Аннотации / конверсии.
// ---------------------------------------------------------------------------

describe('nagForLossE (ADR-066 шкала)', () => {
  it('best/good → нет метки', () => {
    expect(nagForLossE(0)).toBeNull();
    expect(nagForLossE(0.05)).toBeNull();
  });
  it('inaccuracy → ?! (6)', () => {
    expect(nagForLossE(0.1)).toBe(6);
  });
  it('mistake → ? (2)', () => {
    expect(nagForLossE(0.3)).toBe(2);
  });
  it('blunder → ?? (4)', () => {
    expect(nagForLossE(0.7)).toBe(4);
  });
});

describe('wdlFromCp (ADR-066 §6.1 fallback)', () => {
  it('cp=0 → ~ничейно, per-mille сумма ≈ 1000', () => {
    const wdl = wdlFromCp(0);
    expect(wdl.w + wdl.d + wdl.l).toBeGreaterThanOrEqual(999);
    expect(wdl.w + wdl.d + wdl.l).toBeLessThanOrEqual(1001);
    expect(wdl.d).toBeGreaterThan(wdl.w); // равенство → высокая ничья
  });
  it('большое преимущество → W доминирует', () => {
    const wdl = wdlFromCp(2000);
    expect(wdl.w).toBeGreaterThan(wdl.l);
    expect(wdl.w).toBeGreaterThan(500);
  });
  it('большой минус → L доминирует', () => {
    const wdl = wdlFromCp(-2000);
    expect(wdl.l).toBeGreaterThan(wdl.w);
  });
});

describe('positionKey', () => {
  it('игнорирует счётчики полуходов/ходов', () => {
    const a = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const b = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 5 9';
    expect(positionKey(a)).toBe(positionKey(b));
  });
});

describe('unionCandidates', () => {
  it('Maia первыми, пометка источника both/maia/stockfish', () => {
    const res = unionCandidates(['e2e4', 'd2d4'], ['e2e4', 'g1f3']);
    expect(res).toEqual([
      { uci: 'e2e4', source: 'both' },
      { uci: 'd2d4', source: 'maia' },
      { uci: 'g1f3', source: 'stockfish' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Оркестратор — интеграция на mock-движках.
// ---------------------------------------------------------------------------

/**
 * Табличный mock-движок: карта fen → {policy, eval}. `applyMove`
 * симулирует ходы через карту переходов `moves[fen][uci] = childFen`.
 */
function makeEngines(spec: {
  policy: Record<string, Record<string, number>>;
  evals: Record<string, PositionReviewEval | null>;
  transitions: Record<string, Record<string, string>>;
  san?: Record<string, string>;
}): { engines: PositionReviewEngines; calls: { analyze: string[] } } {
  const calls = { analyze: [] as string[] };
  const engines: PositionReviewEngines = {
    getMaiaPolicy: async (fen) => spec.policy[fen] ?? {},
    analyze: async (fen) => {
      calls.analyze.push(fen);
      return fen in spec.evals ? spec.evals[fen] : null;
    },
    applyMove: (fen, uci) => spec.transitions[fen]?.[uci] ?? null,
    toSan: (_fen, uci) => spec.san?.[uci] ?? uci,
  };
  return { engines, calls };
}

const ROOT = 'root w - - 0 1';

describe('formatSfEvalComment', () => {
  it('cp POV белых на ходу — как есть', () => {
    expect(formatSfEvalComment({ type: 'cp', value: 123 }, true)).toBe('SF +1.23');
    expect(formatSfEvalComment({ type: 'cp', value: -50 }, true)).toBe('SF -0.50');
  });
  it('cp POV чёрных на ходу — инверсия к белым', () => {
    expect(formatSfEvalComment({ type: 'cp', value: 200 }, false)).toBe('SF -2.00');
  });
  it('мат', () => {
    expect(formatSfEvalComment({ type: 'mate', value: 3 }, true)).toBe('SF #3');
    expect(formatSfEvalComment({ type: 'mate', value: 2 }, false)).toBe('SF #-2');
  });
});

describe('buildReviewPlan — нет ходов Maia ≥ порога → оценка SF, обрыв', () => {
  it('на ходе соперника нет ходов Maia ≥ порога → annotate с оценкой SF', async () => {
    // Наш ход a (SF) → узел соперника CH, где все ходы Maia < 15% →
    // обрыв ветки с оценкой SF на CH.
    const CH = 'ch b - - 0 1';
    const { engines } = makeEngines({
      policy: { [CH]: { x: 0.1, y: 0.1 } }, // соперник: оба < 0.15
      evals: {
        [ROOT]: { bestUci: 'a', wdl: { w: 400, d: 300, l: 300 }, multipv: ['a'] },
        [CH]: {
          bestUci: 'x',
          wdl: { w: 400, d: 300, l: 300 },
          multipv: ['x'],
          score: { type: 'cp', value: 80 },
        },
      },
      transitions: { [ROOT]: { a: CH } },
    });
    const config = {
      ...defaultReviewConfig(),
      thresholds: { ...defaultReviewConfig().thresholds, pFloor: 0.15, rel: 0, pNucleus: 1 },
    };
    const plan = await buildReviewPlan(ROOT, engines, config);
    const ann = plan.ops.find((o) => o.type === 'annotate') as any;
    expect(ann).toBeDefined();
    expect(ann.comment).toContain('SF');
    // Наш ход a разобран, дальше — оценка SF (соперник без ходов ≥15%).
    expect(plan.ops.filter((o) => o.type === 'move')).toHaveLength(1);
    expect(plan.stats.leaves.terminal).toBeGreaterThanOrEqual(1);
  });
});

describe('buildReviewPlan — стоп по «пониманию» убран (KS-4950)', () => {
  it('ничейная оценка (D>0.95) при SF==Maia всё равно разбирается по Maia', async () => {
    const CHILD = 'child b - - 1 1';
    // Ранее max(W,D,L)>0.95 + SF==Maia → understood-стоп на корне и НИ
    // ОДНОГО хода. Теперь ход Maia e2e4 разбирается (understood убран).
    const { engines } = makeEngines({
      policy: { [ROOT]: { e2e4: 0.9 }, [CHILD]: { zz: 0.99 } },
      evals: {
        // SF-топ = Maia-топ (e2e4) и «ничья» 95.3% — раньше это давало
        // understood; теперь не влияет.
        [ROOT]: { bestUci: 'e2e4', wdl: { w: 40, d: 953, l: 7 }, multipv: ['e2e4'] },
        [CHILD]: { bestUci: 'zz', wdl: { w: 40, d: 953, l: 7 }, multipv: ['zz'] },
      },
      transitions: { [ROOT]: { e2e4: CHILD } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    const moves = plan.ops.filter((o) => o.type === 'move');
    expect(moves.length).toBeGreaterThanOrEqual(1); // ход разобран, не стоп
    expect(moves[0]).toMatchObject({ uci: 'e2e4' });
    expect(plan.stats.leaves.understood).toBe(0); // «понимания» больше нет
  });
});

describe('buildReviewPlan — аварийные лимиты §2', () => {
  it('maxDepth ограничивает глубину', async () => {
    // Бесконечная цепочка: каждая позиция → та же по struct, но с разным
    // FEN (чтобы не сработал repetition), никогда не «понята».
    const N = 20;
    const fens = Array.from({ length: N }, (_, i) => `p${i} w - - 0 1`);
    const policy: Record<string, Record<string, number>> = {};
    const evals: Record<string, PositionReviewEval | null> = {};
    const transitions: Record<string, Record<string, string>> = {};
    for (let i = 0; i < N; i++) {
      policy[fens[i]] = { m: 0.99, x: 0.01 };
      evals[fens[i]] = { bestUci: 'm', wdl: { w: 400, d: 300, l: 300 }, multipv: ['m'] };
      if (i + 1 < N) transitions[fens[i]] = { m: fens[i + 1] };
    }
    const { engines } = makeEngines({ policy, evals, transitions });
    const config: ReviewConfig = {
      ...defaultReviewConfig(),
      limits: { ...defaultReviewConfig().limits, maxDepth: 3, maxNodes: 100 },
    };
    const plan = await buildReviewPlan(fens[0], engines, config);
    expect(plan.stats.maxDepthReached).toBe(3);
    expect(plan.stats.leaves.max_depth).toBeGreaterThanOrEqual(1);
    // 3 полухода записано.
    expect(plan.ops.filter((o) => o.type === 'move')).toHaveLength(3);
  });

  it('maxNodes жёстко обрывает обход', async () => {
    const N = 30;
    const fens = Array.from({ length: N }, (_, i) => `q${i} w - - 0 1`);
    const policy: Record<string, Record<string, number>> = {};
    const evals: Record<string, PositionReviewEval | null> = {};
    const transitions: Record<string, Record<string, string>> = {};
    for (let i = 0; i < N; i++) {
      policy[fens[i]] = { m: 0.99 };
      evals[fens[i]] = { bestUci: 'm', wdl: { w: 400, d: 300, l: 300 }, multipv: ['m'] };
      if (i + 1 < N) transitions[fens[i]] = { m: fens[i + 1] };
    }
    const { engines } = makeEngines({ policy, evals, transitions });
    const config: ReviewConfig = {
      ...defaultReviewConfig(),
      limits: { ...defaultReviewConfig().limits, maxDepth: 100, maxNodes: 5 },
    };
    const plan = await buildReviewPlan(fens[0], engines, config);
    expect(plan.stats.nodes).toBeLessThanOrEqual(5);
    expect(plan.stats.truncatedByNodes).toBe(true);
  });

  it('повтор позиции → лист repetition', async () => {
    const A = 'posA w - - 0 1';
    const B = 'posB b - - 1 1';
    // A → B → A (повтор). Rep guard по positionKey.
    const { engines } = makeEngines({
      policy: { [A]: { m: 0.99 }, [B]: { m: 0.99 } },
      evals: {
        [A]: { bestUci: 'm', wdl: { w: 400, d: 300, l: 300 }, multipv: ['m'] },
        [B]: { bestUci: 'm', wdl: { w: 400, d: 300, l: 300 }, multipv: ['m'] },
      },
      transitions: { [A]: { m: B }, [B]: { m: 'posA w - - 9 5' } },
    });
    const plan = await buildReviewPlan(A, engines, {
      ...defaultReviewConfig(),
      limits: { ...defaultReviewConfig().limits, maxDepth: 100 },
    });
    expect(plan.stats.leaves.repetition).toBeGreaterThanOrEqual(1);
  });
});

describe('buildReviewPlan — ветвление и аннотации', () => {
  it('наш ход = сильнейший SF; ответы соперника = ветки Maia', async () => {
    const CH = 'ch b - - 0 1'; // после нашего хода — ход соперника
    const G1 = 'g1 w - - 0 2';
    const G2 = 'g2 w - - 0 2';
    const decided: PositionReviewEval = {
      bestUci: 'zz',
      wdl: { w: 980, d: 10, l: 10 },
      multipv: ['zz'],
    };
    const { engines } = makeEngines({
      // Maia policy нужна только на ходе соперника (CH).
      policy: { [CH]: { m1: 0.5, m2: 0.4 } },
      evals: {
        // Корень — наш ход: берём сильнейший ход SF (a).
        [ROOT]: { bestUci: 'a', wdl: { w: 500, d: 300, l: 200 }, multipv: ['a'] },
        [CH]: { bestUci: 'm1', wdl: { w: 500, d: 300, l: 200 }, multipv: ['m1'] },
        [G1]: decided,
        [G2]: decided,
      },
      transitions: { [ROOT]: { a: CH }, [CH]: { m1: G1, m2: G2 } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    const moves = plan.ops.filter((o) => o.type === 'move') as any[];
    // Наш ход a (SF) + два ответа соперника m1, m2 (Maia).
    expect(moves.map((m) => m.uci).sort()).toEqual(['a', 'm1', 'm2']);
    expect(moves.find((m) => m.uci === 'a').source).toBe('stockfish');
    // m1 совпал с SF-топом соперника → 'both'; m2 — чистый Maia.
    expect(moves.find((m) => m.uci === 'm2').source).toBe('maia');
  });

  it('за нашу сторону — РОВНО один сильнейший ход SF, без альтернатив', async () => {
    // Корень — наш ход: SF даёт 2 линии (a, b), но берём только лучшую a.
    const CH = 'ch b - - 0 1';
    const { engines } = makeEngines({
      policy: { [CH]: { zz: 0.99 } },
      evals: {
        [ROOT]: { bestUci: 'a', wdl: { w: 500, d: 300, l: 200 }, multipv: ['a', 'b'] },
        [CH]: { bestUci: 'zz', wdl: { w: 500, d: 300, l: 200 }, multipv: ['zz'] },
      },
      transitions: { [ROOT]: { a: CH } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    const ourMoves = (plan.ops.filter((o) => o.type === 'move') as any[]).filter(
      (m) => m.source === 'stockfish',
    );
    // Только a — второй SF-ход b НЕ разбирается за нашу сторону.
    expect(ourMoves.map((m) => m.uci)).toEqual(['a']);
  });

  it('KS-4950: ширина раньше глубины — ответы соперника до наших ответных ходов', async () => {
    const CH = 'ch b - - 0 1'; // соперник ветвится (m1, m2)
    const OM1 = 'om1 w - - 0 2';
    const OM2 = 'om2 w - - 0 2';
    const L1 = 'l1 b - - 0 3';
    const L2 = 'l2 b - - 0 3';
    const { engines } = makeEngines({
      policy: { [CH]: { m1: 0.5, m2: 0.4 } },
      evals: {
        [ROOT]: { bestUci: 'a', wdl: { w: 500, d: 300, l: 200 }, multipv: ['a'] },
        [CH]: { bestUci: 'm1', wdl: { w: 500, d: 300, l: 200 }, multipv: ['m1'] },
        [OM1]: { bestUci: 'x1', wdl: { w: 500, d: 300, l: 200 }, multipv: ['x1'] },
        [OM2]: { bestUci: 'x2', wdl: { w: 500, d: 300, l: 200 }, multipv: ['x2'] },
        [L1]: { bestUci: 'zz', wdl: { w: 980, d: 10, l: 10 }, multipv: ['zz'] },
        [L2]: { bestUci: 'zz', wdl: { w: 980, d: 10, l: 10 }, multipv: ['zz'] },
      },
      transitions: { [ROOT]: { a: CH }, [CH]: { m1: OM1, m2: OM2 }, [OM1]: { x1: L1 }, [OM2]: { x2: L2 } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    const idx = (uci: string) =>
      plan.ops.findIndex((o) => o.type === 'move' && (o as any).uci === uci);
    // Оба ответа соперника (m1, m2) выведены ДО наших ответных ходов (x1, x2).
    expect(Math.max(idx('m1'), idx('m2'))).toBeLessThan(Math.min(idx('x1'), idx('x2')));
  });

  it('KS-4950: сильнейший ответ соперника повышается до главной (promote)', async () => {
    // Ветвление у соперника (CH): ma слабее, mb сильнее по оценке.
    const CH = 'ch b - - 0 1';
    const A_MA = 'ama w - - 0 2';
    const A_MB = 'amb w - - 0 2';
    const { engines } = makeEngines({
      policy: { [CH]: { ma: 0.5, mb: 0.4 } }, // ma первым, mb — вариация
      evals: {
        [ROOT]: { bestUci: 'a', wdl: { w: 500, d: 300, l: 200 }, multipv: ['a'] },
        [CH]: { bestUci: 'ma', wdl: { w: 500, d: 300, l: 200 }, multipv: ['ma'] },
        // POV нашей стороны после ответа соперника: ma нам выгоднее (мы
        // выигрываем) → сильнейший для соперника = mb (нам хуже).
        [A_MA]: { bestUci: 'zz', wdl: { w: 900, d: 50, l: 50 }, multipv: ['zz'] },
        [A_MB]: { bestUci: 'zz', wdl: { w: 50, d: 50, l: 900 }, multipv: ['zz'] },
      },
      transitions: { [ROOT]: { a: CH }, [CH]: { ma: A_MA, mb: A_MB } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    const promoteIdx = plan.ops.findIndex((o) => o.type === 'promote');
    const mbIdx = plan.ops.findIndex(
      (o) => o.type === 'move' && (o as any).uci === 'mb',
    );
    expect(promoteIdx).toBeGreaterThan(0);
    expect(promoteIdx).toBeGreaterThan(mbIdx);
  });

  it('резкое падение WDL у слабого ответа соперника → NAG-аннотация', async () => {
    // Ветвление у соперника: mg сильный, mb слабый (отдаёт партию).
    const CH = 'ch b - - 0 1';
    const A_MG = 'amg w - - 0 2';
    const A_MB = 'amb w - - 0 2';
    const { engines } = makeEngines({
      policy: { [CH]: { mg: 0.6, mb: 0.4 } },
      evals: {
        [ROOT]: { bestUci: 'a', wdl: { w: 500, d: 300, l: 200 }, multipv: ['a'] },
        [CH]: { bestUci: 'mg', wdl: { w: 500, d: 200, l: 300 }, multipv: ['mg'] },
        // POV нашей стороны: после mg мы проигрываем (сильная защита),
        // после mb мы выигрываем (соперник отдал) → mb получает NAG.
        [A_MG]: { bestUci: 'zz', wdl: { w: 900, d: 50, l: 50 }, multipv: ['zz'] },
        [A_MB]: { bestUci: 'zz', wdl: { w: 50, d: 50, l: 900 }, multipv: ['zz'] },
      },
      transitions: { [ROOT]: { a: CH }, [CH]: { mg: A_MG, mb: A_MB } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    const annotations = plan.ops.filter((o) => o.type === 'annotate') as any[];
    expect(annotations.length).toBeGreaterThanOrEqual(1);
    expect(annotations.some((a) => typeof a.nag === 'number')).toBe(true);
  });
});

describe('buildReviewPlan — отмена и прогресс (§7)', () => {
  it('signal.aborted → ReviewAbortError', async () => {
    const { engines } = makeEngines({
      policy: { [ROOT]: { e2e4: 0.9 } },
      evals: { [ROOT]: { bestUci: 'e2e4', wdl: { w: 400, d: 300, l: 300 }, multipv: ['e2e4'] } },
      transitions: {},
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildReviewPlan(ROOT, engines, defaultReviewConfig(), {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ReviewAbortError);
  });

  it('onProgress вызывается по мере раскрытия узлов', async () => {
    const N = 4;
    const fens = Array.from({ length: N }, (_, i) => `pr${i} w - - 0 1`);
    const policy: Record<string, Record<string, number>> = {};
    const evals: Record<string, PositionReviewEval | null> = {};
    const transitions: Record<string, Record<string, string>> = {};
    for (let i = 0; i < N; i++) {
      policy[fens[i]] = { m: 0.99 };
      evals[fens[i]] = { bestUci: 'm', wdl: { w: 400, d: 300, l: 300 }, multipv: ['m'] };
      if (i + 1 < N) transitions[fens[i]] = { m: fens[i + 1] };
    }
    const { engines } = makeEngines({ policy, evals, transitions });
    const seen: number[] = [];
    await buildReviewPlan(fens[0], engines, {
      ...defaultReviewConfig(),
      limits: { ...defaultReviewConfig().limits, maxDepth: 10 },
    }, { onProgress: (n) => seen.push(n) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(Math.max(...seen)); // монотонно растёт
  });
});

describe('buildReviewPlan — деградация без SF (§3.1 no_coi)', () => {
  it('analyze возвращает null → нет сильнейших ходов SF → ходов нет, degradedNoSf', async () => {
    // Корень — наш ход, но SF недоступен → нет сильнейших ходов →
    // ветку не построить (наша сторона играет по SF).
    const engines: PositionReviewEngines = {
      getMaiaPolicy: async (): Promise<Record<string, number>> => ({ e2e4: 0.99 }),
      analyze: async () => null, // SF недоступен везде
      applyMove: () => null,
      toSan: (_f, u) => u,
    };
    const plan = await buildReviewPlan(ROOT, engines);
    expect(plan.stats.degradedNoSf).toBe(true);
    expect(plan.ops.filter((o) => o.type === 'move')).toHaveLength(0);
  });
});
