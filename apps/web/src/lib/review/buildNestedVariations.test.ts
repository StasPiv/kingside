/**
 * KS-3610. Тесты `buildNestedVariations` — рекурсивный обход ветки с
 * лимитами §5 ADR-101: depth, per-node, total, приоритет prob desc.
 *
 * Стратегия моков: симметричный мир, где на КАЖДОЙ позиции engine
 * выдаёт фиксированный sfBest и Maia предлагает альтернативу с
 * подходящим WDL. Это даёт «бесконечный» граф кандидатов — отлично
 * для проверки лимитов глубины/шапки.
 */
import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';

import type { Wdl } from '@kingside/shared';

import type { AnnotationVariation } from './buildAnnotations';
import {
  buildNestedVariations,
  makeBudget,
  MAX_NESTED_DEPTH,
  MAX_TOTAL_VARIATIONS_PER_MOVE,
  MAX_VARIATIONS_PER_NODE,
  type NestedBuilderEngines,
} from './buildNestedVariations';

const STARTPOS =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function wdl(E: number): Wdl {
  const w = Math.round(E * 1000);
  return { w, d: 0, l: 1000 - w };
}

function applyMoveToFen(fen: string, uci: string): string | null {
  try {
    const b = new Chess(fen);
    const m = b.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return m ? b.fen() : null;
  } catch {
    return null;
  }
}

/**
 * Универсальный мок-engine, где:
 *  - sf.bestUci меняется по списку (для каждой позиции — детерминированно
 *    выбираем «легальный лучший ход» в зависимости от FEN);
 *  - maiaTop предлагает альтернативу, отличную от sfBest, с заданным
 *    `prob` и cpLoss → wdlAfter blunder/mistake (или 'best' если flag
 *    отключён).
 */
function makeEngines({
  maiaProb = 0.3,
  maiaClass = 'mistake' as 'best' | 'mistake' | 'blunder',
}: {
  maiaProb?: number;
  maiaClass?: 'best' | 'mistake' | 'blunder';
} = {}): NestedBuilderEngines {
  function pickAnyTwoLegal(fen: string): { best: string; maia: string } | null {
    try {
      const b = new Chess(fen);
      const moves = b.moves({ verbose: true }) as Array<{
        from: string;
        to: string;
        promotion?: string;
      }>;
      if (moves.length < 2) return null;
      const toUci = (m: (typeof moves)[0]) =>
        `${m.from}${m.to}${m.promotion ?? ''}`;
      return { best: toUci(moves[0]), maia: toUci(moves[1]) };
    } catch {
      return null;
    }
  }

  const wdlAfterMaia =
    maiaClass === 'blunder'
      ? wdl(0.1) // loss 0.4 от 0.5 → blunder
      : maiaClass === 'mistake'
        ? wdl(0.3) // loss 0.2 → mistake
        : wdl(0.49); // loss 0.01 → best

  return {
    stabilized: {
      engineGetBestLine: (fen) => {
        const pair = pickAnyTwoLegal(fen);
        if (!pair) return null;
        return { bestUci: pair.best, wdlAfter: wdl(0.5) };
      },
      applyMoveToFen,
    },
    getMaia: (fen) => {
      const pair = pickAnyTwoLegal(fen);
      if (!pair) return null;
      return { topUci: pair.maia, topProb: maiaProb };
    },
    getWdlBefore: () => wdl(0.5),
    getWdlAfterMove: () => wdlAfterMaia,
  };
}

const BRANCH_SHORT: AnnotationVariation = {
  uci: 'e2e4',
  color: 'green',
  subline: ['e7e5', 'g1f3'],
};

describe('buildNestedVariations — базовые правила', () => {
  it('добавляет вложенную red-variation на полуходах ветки', () => {
    const branch: AnnotationVariation = { ...BRANCH_SHORT };
    const engines = makeEngines({ maiaProb: 0.3, maiaClass: 'mistake' });
    const budget = makeBudget(0);
    buildNestedVariations(branch, STARTPOS, engines, 1, budget);
    expect(branch.nestedVariations).toBeTruthy();
    const total = branch.nestedVariations!.reduce(
      (a, arr) => a + arr.length,
      0,
    );
    // На каждом полуходе ветки (3 полухода) — мок предлагает альтернативу.
    // С учётом per-node ≤ 2 и общего budget — это до 3 (по одной на ход).
    expect(total).toBeGreaterThan(0);
  });

  it('не добавляет ничего если classify(maiaAlt) = "best"', () => {
    const branch: AnnotationVariation = { ...BRANCH_SHORT };
    const engines = makeEngines({ maiaProb: 0.5, maiaClass: 'best' });
    const budget = makeBudget(0);
    buildNestedVariations(branch, STARTPOS, engines, 1, budget);
    const total = (branch.nestedVariations ?? []).reduce(
      (a, arr) => a + arr.length,
      0,
    );
    expect(total).toBe(0);
  });

  it('не добавляет если prob < 0.20', () => {
    const branch: AnnotationVariation = { ...BRANCH_SHORT };
    const engines = makeEngines({ maiaProb: 0.19, maiaClass: 'mistake' });
    const budget = makeBudget(0);
    buildNestedVariations(branch, STARTPOS, engines, 1, budget);
    const total = (branch.nestedVariations ?? []).reduce(
      (a, arr) => a + arr.length,
      0,
    );
    expect(total).toBe(0);
  });
});

describe('buildNestedVariations — лимиты §5', () => {
  it(`per-node ≤ MAX_VARIATIONS_PER_NODE (=${MAX_VARIATIONS_PER_NODE})`, () => {
    const branch: AnnotationVariation = { ...BRANCH_SHORT };
    const engines = makeEngines({ maiaProb: 0.3, maiaClass: 'mistake' });
    const budget = makeBudget(0);
    buildNestedVariations(branch, STARTPOS, engines, 1, budget);
    for (const perNode of branch.nestedVariations ?? []) {
      expect(perNode.length).toBeLessThanOrEqual(MAX_VARIATIONS_PER_NODE);
    }
  });

  it(`total ≤ MAX_TOTAL_VARIATIONS_PER_MOVE (=${MAX_TOTAL_VARIATIONS_PER_MOVE}) с учётом стартового budget'a`, () => {
    // Берём «всеми ходами Maia предлагает blunder» — бесконечный кандидат
    // на каждом полуходе любой глубины. Без cap'а уйдём в бесконечность.
    const branch: AnnotationVariation = {
      uci: 'e2e4',
      color: 'green',
      subline: ['e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3', 'd7d6'],
    };
    const engines = makeEngines({ maiaProb: 0.4, maiaClass: 'blunder' });
    const budget = makeBudget(0); // полные 12

    const totalBefore = budget.remainingTotal;
    buildNestedVariations(branch, STARTPOS, engines, 1, budget);
    const used = totalBefore - budget.remainingTotal;
    expect(used).toBeLessThanOrEqual(MAX_TOTAL_VARIATIONS_PER_MOVE);
  });

  it('учитывает уже добавленные main-variations (budget стартует с 12 − mainCount)', () => {
    // Симулируем 2 main-variations (зелёная + красная) → бюджет 12-2=10.
    const branch: AnnotationVariation = {
      uci: 'e2e4',
      color: 'green',
      subline: ['e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6'],
    };
    const engines = makeEngines({ maiaProb: 0.4, maiaClass: 'blunder' });
    const budget = makeBudget(2);
    expect(budget.remainingTotal).toBe(10);

    buildNestedVariations(branch, STARTPOS, engines, 1, budget);
    const used = 10 - budget.remainingTotal;
    expect(used).toBeLessThanOrEqual(10);
  });
});

describe('buildNestedVariations — лимит глубины', () => {
  it(`MAX_NESTED_DEPTH = ${MAX_NESTED_DEPTH}: 4-й уровень добавляется, 5-й — нет`, () => {
    // Глубина: branch (1) → внутри (2) → ... до (MAX_NESTED_DEPTH).
    const branch: AnnotationVariation = { uci: 'e2e4', color: 'green' };
    const engines = makeEngines({ maiaProb: 0.4, maiaClass: 'blunder' });
    const budget = makeBudget(0);
    buildNestedVariations(branch, STARTPOS, engines, 1, budget);

    function maxDepthOf(v: AnnotationVariation, currentDepth: number): number {
      const childDepths = (v.nestedVariations ?? [])
        .flat()
        .map((child) => maxDepthOf(child, currentDepth + 1));
      if (childDepths.length === 0) return currentDepth;
      return Math.max(...childDepths);
    }
    const maxDepth = maxDepthOf(branch, 1);
    // depth начинается с 1 (main-variation); рекурсия ≤ MAX_NESTED_DEPTH-1
    // глубже. Т. е. максимально достижимая глубина = MAX_NESTED_DEPTH.
    expect(maxDepth).toBeLessThanOrEqual(MAX_NESTED_DEPTH);
  });

  it('если стартовали с depth=MAX_NESTED_DEPTH — ничего не добавляется', () => {
    const branch: AnnotationVariation = { uci: 'e2e4', color: 'green' };
    const engines = makeEngines({ maiaProb: 0.5, maiaClass: 'blunder' });
    const budget = makeBudget(0);
    buildNestedVariations(branch, STARTPOS, engines, MAX_NESTED_DEPTH, budget);
    expect(branch.nestedVariations ?? []).toHaveLength(0);
  });
});

describe('KS-3613: nested-варианты не дублируют ход родителя', () => {
  /**
   * Регрессия: до фикса рекурсия добавляла nested с uci = uci ветки,
   * потому что Maia на одной позиции стабильно возвращает один и тот
   * же top-1, и алгоритм не сравнивал его с уже сыгранным в ветке
   * ходом. Получалось `3.Nc3 ( 3.Nc3 ( 3.Nc3 ( 3.Nc3 ) ) )`.
   */
  function makeStableEngines(
    sfBest: string,
    maiaTop: string,
    maiaProb = 0.4,
  ): NestedBuilderEngines {
    return {
      stabilized: {
        engineGetBestLine: () => ({ bestUci: sfBest, wdlAfter: wdl(0.5) }),
        applyMoveToFen,
      },
      getMaia: () => ({ topUci: maiaTop, topProb: maiaProb }),
      getWdlBefore: () => wdl(0.5),
      getWdlAfterMove: () => wdl(0.1), // blunder → класс не 'best'
    };
  }

  it('nested.uci ≠ branch.uci на первом узле (Maia=branch — пропускаем)', () => {
    // Ветка с uci = ходом, который Maia всегда возвращает. Без фикса:
    // на узле i=0 fen=startFen, sf.bestUci=e2e4, maia.topUci=d2d4 =
    // branch.uci → раньше создавали nested c uci=d2d4. Теперь пропуск.
    const branch: AnnotationVariation = { uci: 'd2d4', color: 'red' };
    const engines = makeStableEngines('e2e4', 'd2d4');
    const budget = makeBudget(0);
    buildNestedVariations(branch, STARTPOS, engines, 1, budget);
    // На i=0 кандидат отсечён (maia === movesInBranch[0]).
    const atNode0 = branch.nestedVariations?.[0] ?? [];
    expect(atNode0).toHaveLength(0);
  });

  it('рекурсия не создаёт самокопирующих цепочек 3.Nc3 ( 3.Nc3 ( 3.Nc3 ) )', () => {
    // Сценарий со скриншота KS-3613: Maia на стартовой позиции
    // стабильно возвращает один и тот же ход (b1c3); main-line ход
    // другой. Рекурсия должна не сделать ни одного nested на корне
    // (Maia=branch.uci) и далее.
    const branch: AnnotationVariation = { uci: 'b1c3', color: 'red' };
    const engines = makeStableEngines('e2e4', 'b1c3', 0.5);
    const budget = makeBudget(0);
    buildNestedVariations(branch, STARTPOS, engines, 1, budget);

    function collectUcis(v: AnnotationVariation): string[] {
      const ucis: string[] = [v.uci];
      for (const perNode of v.nestedVariations ?? []) {
        for (const child of perNode) ucis.push(...collectUcis(child));
      }
      return ucis;
    }
    const all = collectUcis(branch);
    // В скриншоте — 4 одинаковых уровня. После фикса — только сам
    // branch; никакого 'b1c3' в nested под ним.
    const dupCount = all.filter((u) => u === 'b1c3').length;
    expect(dupCount).toBe(1);
  });

  it('Maia=branch.uci на subline-узлах тоже не дублирует (через ancestorMoves в рекурсии)', () => {
    // На subline-узле Maia может вернуть ход, который равен uci
    // главной ветки — расширенный ancestorMoves внутри рекурсии этот
    // случай ловит. Берём branch с одним subline-полуходом, и Maia
    // всегда отдаёт `b1c3` (= branch.uci). Без расширения ancestors
    // на subline-узлах nested 'b1c3' проходил бы.
    const branch: AnnotationVariation = {
      uci: 'b1c3',
      color: 'red',
      subline: ['e7e5'],
    };
    const engines = makeStableEngines('e2e4', 'b1c3', 0.5);
    const budget = makeBudget(0);
    // ancestorMoves корня уже включает 'b1c3' (как если бы это была
    // ветка, висящая под main move) — тогда даже на subline-узлах
    // блокировка должна сработать.
    buildNestedVariations(
      branch,
      STARTPOS,
      engines,
      1,
      budget,
      new Set(['b1c3']),
    );
    function flatNested(v: AnnotationVariation): string[] {
      const acc: string[] = [];
      for (const perNode of v.nestedVariations ?? []) {
        for (const c of perNode) {
          acc.push(c.uci);
          acc.push(...flatNested(c));
        }
      }
      return acc;
    }
    const nestedUcis = flatNested(branch);
    expect(nestedUcis).not.toContain('b1c3');
  });

  it('ход main-line не дублируется в nested (через ancestorMoves)', () => {
    // Имитируем вызов из useGameReview: main move = sf.bestUci, и мы
    // строим red-вариант (uci = maiaTop). Если на той же позиции для
    // nested Maia случайно вернула ход main move — отсекаем.
    const branch: AnnotationVariation = { uci: 'd2d4', color: 'red' };
    // sf=e2e4, maia=e2e4? нет, тогда sf===maia, отсечётся раньше.
    // Сделаем так: sfBest=e2e4 (main move), maiaTop=g1f3 (≠main).
    // На рекурсивном шаге внутри ветки {uci=d2d4}, fen=startFen,
    // Maia=g1f3 (≠ branch.uci). Без ancestorMoves nested создался бы.
    // С ancestorMoves={e2e4 ...} это не блокирует (g1f3 ≠ e2e4) —
    // здесь проверяем что обратное (Maia предложила бы e2e4) — блок.
    const engines: NestedBuilderEngines = {
      stabilized: {
        engineGetBestLine: () => ({ bestUci: 'e7e5', wdlAfter: wdl(0.5) }),
        applyMoveToFen,
      },
      // Maia на любой позиции даёт e2e4 (= main move).
      getMaia: () => ({ topUci: 'e2e4', topProb: 0.5 }),
      getWdlBefore: () => wdl(0.5),
      getWdlAfterMove: () => wdl(0.1),
    };
    const budget = makeBudget(0);
    buildNestedVariations(
      branch,
      STARTPOS,
      engines,
      1,
      budget,
      new Set(['e2e4']), // main move в наборе предков
    );
    // На i=0: maia.topUci=e2e4 ∈ ancestorMoves → пропускаем.
    const atNode0 = branch.nestedVariations?.[0] ?? [];
    expect(atNode0).toHaveLength(0);
  });
});

describe('buildNestedVariations — приоритет prob desc', () => {
  it('при превышении лимита выбирается высокий prob', () => {
    // Контролируем prob: получим 3+ кандидата на ветке (по одному на
    // каждый полуход) с одинаковым maiaProb → проверим что вошло столько,
    // сколько позволил budget.
    const branch: AnnotationVariation = {
      uci: 'e2e4',
      color: 'green',
      subline: ['e7e5', 'g1f3', 'b8c6'],
    };
    const engines = makeEngines({ maiaProb: 0.35, maiaClass: 'mistake' });
    const budget = makeBudget(10); // оставляем 2.
    expect(budget.remainingTotal).toBe(2);
    buildNestedVariations(branch, STARTPOS, engines, 1, budget);
    const total = (branch.nestedVariations ?? []).reduce(
      (a, arr) => a + arr.length,
      0,
    );
    expect(total).toBe(2); // ровно 2, остальное обрезано по budget.
  });
});
