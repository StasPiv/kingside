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
  REVIEW_ROOT_ID,
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
  it('все ходы < pFloor → annotate с оценкой SF, лист terminal', async () => {
    const { engines } = makeEngines({
      policy: { [ROOT]: { a: 0.1, b: 0.1 } }, // оба < 0.15
      evals: {
        [ROOT]: {
          bestUci: 'a',
          wdl: { w: 400, d: 300, l: 300 },
          multipv: ['a'],
          score: { type: 'cp', value: 80 },
        },
      },
      transitions: {},
    });
    const config = {
      ...defaultReviewConfig(),
      thresholds: { ...defaultReviewConfig().thresholds, pFloor: 0.15, rel: 0, pNucleus: 1 },
    };
    const plan = await buildReviewPlan(ROOT, engines, config);
    const ann = plan.ops.find((o) => o.type === 'annotate') as any;
    expect(ann).toBeDefined();
    expect(ann.comment).toContain('SF');
    expect(plan.ops.filter((o) => o.type === 'move')).toHaveLength(0);
    expect(plan.stats.leaves.terminal).toBe(1);
  });
});

describe('buildReviewPlan — стоп-условие §4', () => {
  it('корень уже понят (SF==Maia, decided) → только goto, лист understood', async () => {
    const { engines } = makeEngines({
      policy: { [ROOT]: { e2e4: 0.9, d2d4: 0.1 } },
      evals: { [ROOT]: { bestUci: 'e2e4', wdl: { w: 980, d: 15, l: 5 }, multipv: ['e2e4'] } },
      transitions: {},
    });
    const plan = await buildReviewPlan(ROOT, engines);
    expect(plan.ops).toEqual([{ type: 'goto', toId: REVIEW_ROOT_ID }]);
    expect(plan.stats.leaves.understood).toBe(1);
    expect(plan.stats.nodes).toBe(1);
  });

  it('рекурсия останавливается по §4 на дочернем узле', async () => {
    const CHILD = 'child b - - 1 1';
    // Корень: не понят (исход не decided). Один кандидат e2e4 → CHILD.
    // CHILD: понят (SF==Maia, decided) → лист.
    const { engines } = makeEngines({
      policy: {
        [ROOT]: { e2e4: 0.95, d2d4: 0.05 },
        [CHILD]: { e7e5: 0.9, c7c5: 0.1 },
      },
      evals: {
        // SF-топ d2d4 (расходится с Maia e2e4) без перехода → отсеётся;
        // остаётся чистый Maia-кандидат e2e4.
        [ROOT]: { bestUci: 'd2d4', wdl: { w: 500, d: 300, l: 200 }, multipv: ['d2d4'] },
        // eval дочерней позиции (POV соперника) для evalAfterMove:
        [CHILD]: { bestUci: 'e7e5', wdl: { w: 980, d: 15, l: 5 }, multipv: ['e7e5'] },
      },
      transitions: { [ROOT]: { e2e4: CHILD } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    const moves = plan.ops.filter((o) => o.type === 'move');
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ uci: 'e2e4', source: 'maia' });
    expect(plan.stats.leaves.understood).toBe(1);
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
  it('кандидаты только по Maia: два человеческих хода → две ветки, goto между ними', async () => {
    const CH_E4 = 'afterE4 b - - 0 1';
    const CH_D4 = 'afterD4 b - - 0 1';
    // Maia даёт два вероятных хода (e2e4, d2d4) — обе ветки. SF-топ
    // (e2e4) лишь помечает source='both', на отбор не влияет.
    const decidedChild: PositionReviewEval = {
      bestUci: 'zz',
      wdl: { w: 980, d: 10, l: 10 },
      multipv: ['zz'],
    };
    const { engines } = makeEngines({
      policy: {
        [ROOT]: { e2e4: 0.5, d2d4: 0.4 },
        [CH_E4]: { zz: 0.99 },
        [CH_D4]: { zz: 0.99 },
      },
      evals: {
        [ROOT]: { bestUci: 'e2e4', wdl: { w: 500, d: 300, l: 200 }, multipv: ['e2e4'] },
        [CH_E4]: decidedChild,
        [CH_D4]: decidedChild,
      },
      transitions: { [ROOT]: { e2e4: CH_E4, d2d4: CH_D4 } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    const moves = plan.ops.filter((o) => o.type === 'move');
    expect(moves.map((m: any) => m.uci).sort()).toEqual(['d2d4', 'e2e4']);
    // Оба — Maia-кандидаты; e2e4 совпал с SF-топом → 'both', d2d4 → 'maia'.
    const e4 = moves.find((m: any) => m.uci === 'e2e4') as any;
    const d4 = moves.find((m: any) => m.uci === 'd2d4') as any;
    expect(e4.source).toBe('both');
    expect(d4.source).toBe('maia');
    // Возврат к развилке между сиблингами.
    const gotoRoots = plan.ops.filter(
      (o) => o.type === 'goto' && o.toId === REVIEW_ROOT_ID,
    );
    expect(gotoRoots.length).toBeGreaterThanOrEqual(2); // начальный + возврат
  });

  it('SF-ход НЕ становится кандидатом, если его нет в Maia policy', async () => {
    const CH = 'afterMaia b - - 0 1';
    // Maia уверенно даёт один ход (m1); SF-топ (sfx) другой, но в Maia
    // его нет → в кандидаты не попадает. Разбирается только m1.
    const { engines } = makeEngines({
      policy: { [ROOT]: { m1: 0.95, m2: 0.05 }, [CH]: { zz: 0.99 } },
      evals: {
        [ROOT]: { bestUci: 'sfx', wdl: { w: 500, d: 300, l: 200 }, multipv: ['sfx', 'm1'] },
        [CH]: { bestUci: 'zz', wdl: { w: 980, d: 10, l: 10 }, multipv: ['zz'] },
      },
      transitions: { [ROOT]: { m1: CH } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    const moves = plan.ops.filter((o) => o.type === 'move') as any[];
    expect(moves.map((m) => m.uci)).toEqual(['m1']); // sfx не разбирается
  });

  it('KS-4950: ширина раньше глубины — обе альтернативы 1-го хода до внуков', async () => {
    const CH_A = 'chA b - - 0 1';
    const CH_B = 'chB b - - 0 1';
    const GA = 'gA w - - 0 2';
    const GB = 'gB w - - 0 2';
    const decided: PositionReviewEval = {
      bestUci: 'zz',
      wdl: { w: 980, d: 10, l: 10 },
      multipv: ['zz'],
    };
    const { engines } = makeEngines({
      policy: {
        [ROOT]: { a: 0.5, b: 0.4 }, // две альтернативы 1-го хода
        [CH_A]: { ga: 0.9 },
        [CH_B]: { gb: 0.9 },
        [GA]: { zz: 0.99 },
        [GB]: { zz: 0.99 },
      },
      evals: {
        [ROOT]: { bestUci: 'a', wdl: { w: 500, d: 300, l: 200 }, multipv: ['a'] },
        // Не «понято» (SF-топ ≠ Maia-топ) → узлы углубляются к внукам.
        [CH_A]: { bestUci: 'x', wdl: { w: 400, d: 300, l: 300 }, multipv: ['x'] },
        [CH_B]: { bestUci: 'x', wdl: { w: 400, d: 300, l: 300 }, multipv: ['x'] },
        [GA]: decided,
        [GB]: decided,
      },
      transitions: { [ROOT]: { a: CH_A, b: CH_B }, [CH_A]: { ga: GA }, [CH_B]: { gb: GB } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    const idx = (uci: string) =>
      plan.ops.findIndex((o) => o.type === 'move' && (o as any).uci === uci);
    // Обе альтернативы 1-го хода (a, b) выведены ДО внуков (ga, gb).
    expect(idx('a')).toBeGreaterThanOrEqual(0);
    expect(idx('b')).toBeGreaterThanOrEqual(0);
    expect(Math.max(idx('a'), idx('b'))).toBeLessThan(Math.min(idx('ga'), idx('gb')));
  });

  it('KS-4950: сильнейший по оценке сиблинг повышается до главной (promote)', async () => {
    const CH_A = 'afterA b - - 0 1'; // слабый ход
    const CH_B = 'afterB b - - 0 1'; // сильный ход
    const { engines } = makeEngines({
      policy: {
        [ROOT]: { a: 0.6, b: 0.4 }, // a первым (главная), b — вариация
        [CH_A]: { zz: 0.99 },
        [CH_B]: { zz: 0.99 },
      },
      evals: {
        [ROOT]: { bestUci: 'a', wdl: { w: 500, d: 300, l: 200 }, multipv: ['a', 'b'] },
        // POV соперника: после a соперник выигрывает (a слабый), после b — проигрывает (b сильный).
        [CH_A]: { bestUci: 'zz', wdl: { w: 900, d: 50, l: 50 }, multipv: ['zz'] },
        [CH_B]: { bestUci: 'zz', wdl: { w: 50, d: 50, l: 900 }, multipv: ['zz'] },
      },
      transitions: { [ROOT]: { a: CH_A, b: CH_B } },
    });
    const plan = await buildReviewPlan(ROOT, engines);
    // Есть promote, и он идёт ПОСЛЕ хода b (сильнейшего сиблинга).
    const promoteIdx = plan.ops.findIndex((o) => o.type === 'promote');
    expect(promoteIdx).toBeGreaterThan(0);
    const bMoveIdx = plan.ops.findIndex(
      (o) => o.type === 'move' && (o as any).uci === 'b',
    );
    expect(bMoveIdx).toBeGreaterThanOrEqual(0);
    expect(promoteIdx).toBeGreaterThan(bMoveIdx);
    // Для одиночного набора кандидатов (без второго сиблинга) promote не эмитится.
  });

  it('резкое падение WDL у слабого хода → NAG-аннотация', async () => {
    const GOOD = 'good b - - 0 1'; // сильный ход: сохраняет перевес
    const BAD = 'bad b - - 0 1'; // слабый ход: отдаёт партию
    // POV сделавшего ход: evalAfterMove инвертирует POV соперника.
    // GOOD-ребёнок POV соперника = проигрывает → invert → мы выигрываем.
    // BAD-ребёнок POV соперника = выигрывает → invert → мы проигрываем.
    const { engines } = makeEngines({
      policy: { [ROOT]: { g: 0.6, b: 0.4 }, [GOOD]: { zz: 0.99 }, [BAD]: { zz: 0.99 } },
      evals: {
        [ROOT]: { bestUci: 'g', wdl: { w: 500, d: 200, l: 300 }, multipv: ['g', 'b'] },
        [GOOD]: { bestUci: 'zz', wdl: { w: 950, d: 30, l: 20 }, multipv: ['zz'] }, // соперник ~проигрывает после нашего g? нет
        [BAD]: { bestUci: 'zz', wdl: { w: 950, d: 30, l: 20 }, multipv: ['zz'] },
      },
      transitions: { [ROOT]: { g: GOOD, b: BAD } },
    });
    // Настроим так, чтобы g был силён, b слаб: сделаем eval GOOD POV
    // соперника = проигрывает (l высок), BAD POV соперника = выигрывает.
    engines.analyze = async (fen) => {
      if (fen === ROOT)
        return { bestUci: 'g', wdl: { w: 500, d: 200, l: 300 }, multipv: ['g', 'b'] };
      if (fen === GOOD)
        return { bestUci: 'zz', wdl: { w: 50, d: 50, l: 900 }, multipv: ['zz'] }; // соперник проигрывает → мы выигрываем
      if (fen === BAD)
        return { bestUci: 'zz', wdl: { w: 900, d: 50, l: 50 }, multipv: ['zz'] }; // соперник выигрывает → мы проигрываем
      return null;
    };
    const plan = await buildReviewPlan(ROOT, engines);
    const annotations = plan.ops.filter((o) => o.type === 'annotate') as any[];
    expect(annotations.length).toBeGreaterThanOrEqual(1);
    // NAG стоит (blunder/mistake) и комментарий содержит SAN.
    expect(annotations[0].nag).toBeDefined();
    expect(annotations[0].comment).toContain('b');
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
  it('analyze возвращает null → Maia-only, degradedNoSf, обход по лимитам', async () => {
    const CHILD = 'c1 b - - 0 1';
    const engines: PositionReviewEngines = {
      getMaiaPolicy: async (fen): Promise<Record<string, number>> =>
        fen === ROOT ? { e2e4: 0.99 } : { e7e5: 0.99 },
      analyze: async () => null, // SF недоступен везде
      applyMove: (fen, uci) => (fen === ROOT && uci === 'e2e4' ? CHILD : null),
      toSan: (_f, u) => u,
    };
    const plan = await buildReviewPlan(ROOT, engines, {
      ...defaultReviewConfig(),
      limits: { ...defaultReviewConfig().limits, maxDepth: 1 },
    });
    expect(plan.stats.degradedNoSf).toBe(true);
    // Без SF нет WDL → аннотаций не ставим.
    expect(plan.ops.filter((o) => o.type === 'annotate')).toHaveLength(0);
    // Один ход e2e4 записан (Maia-кандидат), дальше maxDepth.
    expect(plan.ops.filter((o) => o.type === 'move')).toHaveLength(1);
  });
});
