/**
 * KS-3610 (ADR-101 §4.2 v2, §5). Рекурсивная сборка nested-variations.
 *
 * Однородный фрейм (§4.0): на **любом** полуходе любой ветки —
 * включая уже добавленные variations — применяется одно и то же
 * правило «Maia-альтернатива»:
 *
 *   maiaTop !== sfBest
 *   && maiaProb[maiaTop] >= MAIA_ALT_MIN_PROB (0.20)
 *   && classifyMove(wdlBefore, wdlAfterMaiaTop) !== 'best'
 *   → добавить nested red-variation с stabilized-subline (cap=4).
 *
 * Лимиты §5:
 *  - `MAX_NESTED_DEPTH = 4` — глубина рекурсии (main-line = 0,
 *    main-variation = 1, nested = 2, ...). Главные green/red ветки
 *    стартуют с depth=1; их вложенные — depth=2; и т.д. до depth=4.
 *  - `MAX_VARIATIONS_PER_NODE = 2` — не более 2 вложенных на каждом
 *    индивидуальном полуходе ветки.
 *  - `MAX_TOTAL_VARIATIONS_PER_MOVE = 12` — soft cap на основной
 *    main-line полуход (включает main variations и все nested
 *    вложения под ними).
 *  - Приоритет при превышении лимитов — `maiaTopProb desc`.
 */
import { Chess } from 'chess.js';

import { classifyMove, type Wdl } from '@kingside/shared';

import type { AnnotationVariation } from './buildAnnotations';
import {
  MAIA_ALT_MIN_PROB,
  NAG_BLUNDER,
  NAG_MISTAKE,
} from './buildAnnotations';
import {
  buildStabilizedLine,
  SUB_VARIATION_MAX_LENGTH_PLIES,
  type StabilizedEngines,
} from './buildStabilizedLine';

export const MAX_NESTED_DEPTH = 4;
export const MAX_VARIATIONS_PER_NODE = 2;
export const MAX_TOTAL_VARIATIONS_PER_MOVE = 12;

export interface NestedBuilderEngines {
  stabilized: StabilizedEngines;
  /** Maia top-1 ход и его вероятность для позиции `fen`. */
  getMaia: (fen: string) => { topUci: string; topProb: number } | null;
  /**
   * WDL POV ходящей стороны на `fen` ДО ходов. Используется для
   * `classifyMove(wdlBefore, ...)`. `null` — позиция вне кэша / не
   * посчитана.
   */
  getWdlBefore: (fen: string) => Wdl | null;
  /**
   * WDL после `uci` на позиции `fen`, POV того же игрока что ходил.
   * Внутри обычно: проверка кэша на `fenAfter = applyMove(fen, uci)`
   * + invertWdl (там новая STM — соперник). `null` если данных нет.
   */
  getWdlAfterMove: (fen: string, uci: string) => Wdl | null;
}

export interface NestedBuilderBudget {
  /** Сколько ещё variations можно добавить под этим main-полуходом. */
  remainingTotal: number;
}

function applyMoveToFen(fen: string, uci: string): string | null {
  try {
    const b = new Chess(fen);
    const move = b.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move ? b.fen() : null;
  } catch {
    return null;
  }
}

function nagForClass(klass: ReturnType<typeof classifyMove>): number[] | undefined {
  if (klass === 'blunder') return [NAG_BLUNDER];
  if (klass === 'mistake') return [NAG_MISTAKE];
  return undefined;
}

interface NestedCandidate {
  variation: AnnotationVariation;
  prob: number;
  /** Индекс полухода в branch'е (0 — uci, 1 — subline[0], ...). */
  nodeIndex: number;
  /** FEN перед полуходом, для рекурсии. */
  fenAtNode: string;
}

/**
 * Рекурсивно добавляет вложенные variations к `branch`.
 *
 * `branch` мутируется in-place: заполняется `branch.nestedVariations`.
 * Caller передаёт `fenAtBranchStart` — позицию перед `branch.uci`.
 * `depth` — текущая глубина (главная main-variation стартует с 1).
 * `budget` — общий счётчик на этот main-line полуход (мутируется).
 * `ancestorMoves` — KS-3613: набор UCI-ходов всех родительских веток
 *   (включая main-line ход, на котором висит главная variation).
 *   Maia-альт-ход, совпадающий с любым из них, отсекается — иначе при
 *   рекурсии на ту же позицию Maia предлагает тот же top-1, и nested
 *   получается дублем родителя (`3.Nc3 ( 3.Nc3 ( 3.Nc3 ) )`).
 */
export function buildNestedVariations(
  branch: AnnotationVariation,
  fenAtBranchStart: string,
  engines: NestedBuilderEngines,
  depth: number,
  budget: NestedBuilderBudget,
  ancestorMoves: ReadonlySet<string> = new Set(),
): void {
  if (depth >= MAX_NESTED_DEPTH) return;
  if (budget.remainingTotal <= 0) return;

  // Список полуходов ветки и FEN перед каждым.
  const movesInBranch: string[] = [
    branch.uci,
    ...(branch.subline ?? []),
  ];
  const fenBefore: (string | null)[] = [];
  let cur: string | null = fenAtBranchStart;
  for (const u of movesInBranch) {
    fenBefore.push(cur);
    cur = cur ? applyMoveToFen(cur, u) : null;
  }

  // Соберём кандидаты на этой ветке.
  const candidates: NestedCandidate[] = [];

  for (let i = 0; i < fenBefore.length; i++) {
    const fen = fenBefore[i];
    if (!fen) continue;
    const sf = engines.stabilized.engineGetBestLine(fen);
    if (!sf) continue;
    const maia = engines.getMaia(fen);
    if (!maia || !maia.topUci) continue;
    if (maia.topUci === sf.bestUci) continue;
    // KS-3613: Maia ≠ ход самой ветки на этом узле. Без этой проверки
    // на узле i=0 ветки с `branch.uci = maiaTop` (red-variation) при
    // рекурсии Maia опять предлагает тот же ход — получаем дубль.
    if (maia.topUci === movesInBranch[i]) continue;
    // KS-3613: Maia ≠ ходу любого из родительских узлов. Предотвращает
    // случай когда на разной глубине рекурсии Maia натыкается на ход,
    // который уже фигурирует выше по цепочке вариантов.
    if (ancestorMoves.has(maia.topUci)) continue;
    if (maia.topProb < MAIA_ALT_MIN_PROB) continue;
    const wdlBefore = engines.getWdlBefore(fen);
    if (!wdlBefore) continue;
    const wdlAfterMaiaTop = engines.getWdlAfterMove(fen, maia.topUci);
    if (!wdlAfterMaiaTop) continue;
    const klass = classifyMove({ wdlBefore, wdlAfter: wdlAfterMaiaTop });
    if (klass === 'best') continue;

    // Stabilized subline для этой red-альтернативы (cap=4).
    const stab = buildStabilizedLine(
      fen,
      { uci: maia.topUci, wdlAfter: wdlAfterMaiaTop },
      engines.stabilized,
      SUB_VARIATION_MAX_LENGTH_PLIES,
    );
    const subline = stab.length > 1 ? stab.slice(1) : undefined;

    const nestedVar: AnnotationVariation = {
      uci: maia.topUci,
      color: 'red',
      subline,
      nag: nagForClass(klass),
    };
    candidates.push({
      variation: nestedVar,
      prob: maia.topProb,
      nodeIndex: i,
      fenAtNode: fen,
    });
  }

  if (candidates.length === 0) return;

  // Приоритет: maiaTopProb desc (§5).
  candidates.sort((a, b) => b.prob - a.prob);

  // Распределение под лимитами:
  //  - per-node ≤ MAX_VARIATIONS_PER_NODE;
  //  - total ≤ budget.remainingTotal.
  const perNodeCount = new Map<number, number>();
  const chosen: NestedCandidate[] = [];
  for (const c of candidates) {
    if (budget.remainingTotal <= 0) break;
    const cnt = perNodeCount.get(c.nodeIndex) ?? 0;
    if (cnt >= MAX_VARIATIONS_PER_NODE) continue;
    chosen.push(c);
    perNodeCount.set(c.nodeIndex, cnt + 1);
    budget.remainingTotal--;
  }

  if (chosen.length === 0) return;

  // Раскладка по индексам полуходов ветки.
  if (!branch.nestedVariations) {
    branch.nestedVariations = Array.from(
      { length: movesInBranch.length },
      () => [] as AnnotationVariation[],
    );
  }
  // Гарантируем размер (если subline появился позже).
  while (branch.nestedVariations.length < movesInBranch.length) {
    branch.nestedVariations.push([]);
  }
  for (const c of chosen) {
    branch.nestedVariations[c.nodeIndex].push(c.variation);
  }

  // Рекурсия: каждую выбранную nested-variation тоже обрабатываем,
  // depth+1. Budget общий — продолжаем убывать. KS-3613: расширяем
  // ancestorMoves ходами текущей ветки, чтобы вглубь по той же ветке
  // Maia не предлагал тот же ход (классический self-copy).
  const nextAncestors = new Set<string>(ancestorMoves);
  for (const u of movesInBranch) nextAncestors.add(u);
  for (const c of chosen) {
    buildNestedVariations(
      c.variation,
      c.fenAtNode,
      engines,
      depth + 1,
      budget,
      nextAncestors,
    );
  }
}

/**
 * Конструктор начального budget'а. Учитывает уже добавленные
 * main-line variations (зелёная + красная) — они тоже считаются по §5.
 */
export function makeBudget(mainVariationsCount: number): NestedBuilderBudget {
  return {
    remainingTotal: Math.max(0, MAX_TOTAL_VARIATIONS_PER_MOVE - mainVariationsCount),
  };
}
