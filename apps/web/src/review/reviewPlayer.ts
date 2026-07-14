/**
 * KS-4944 (ADR-165 §5-§6). Чистая логика проигрывателя разбора
 * `ReviewPlayer`: применение операций `ReviewPlan` к `useReviewState`
 * по одному полуходу за тик + тайминги/скорость/reduced-motion.
 *
 * RAF-обвязка и React-состояние — в хуке `hooks/useReviewPlayer.ts`;
 * здесь только детерминированные функции (образец
 * `LectureReplayPage.findApplicableEventIndex` — pure + отдельный тест):
 *   - `parseUci` — UCI → {from,to,promotion};
 *   - `holdMsForOp` / `effectiveHoldMs` — пауза перед следующей операцией;
 *   - `findMoveByGlobalIndex` — поиск узла дерева по globalIndex;
 *   - `applyReviewOp` — диспатч одной операции плана в review-actions;
 *   - `reviewProgress` — «узел i из N» по move-операциям.
 *
 * Гонки async dispatch (ADR §7): плеер применяет РОВНО одну операцию за
 * тик. `move` пишет узел (makeVariantMove), а следующая за ним
 * `annotate` применяется уже на другом тике — к моменту её вызова React
 * закоммитил move и `currentGlobalIndex` указывает на новый узел.
 */
import {
  REVIEW_ROOT_ID,
  type ReviewPlan,
  type ReviewPlanOp,
} from '../lib/review/positionReview';
import type { ChessMove } from './types';

// ---------------------------------------------------------------------------
// Тайминги (ADR-165 §6).
// ---------------------------------------------------------------------------

export interface ReviewTimings {
  /** Слайд фигуры при ходе, мс. */
  animateMoveMs: number;
  /** Пауза после хода, мс. */
  holdMoveMs: number;
  /** Пауза на узле-развилке/ловушке (аннотация), мс. */
  holdKeyMs: number;
  /** Снап-возврат к развилке (goto), мс. */
  resetMs: number;
}

export const DEFAULT_REVIEW_TIMINGS: ReviewTimings = {
  animateMoveMs: 220,
  holdMoveMs: 900,
  holdKeyMs: 1800,
  resetMs: 0,
};

/** Диапазон множителя скорости (ADR §6). */
export const REVIEW_SPEED_MIN = 0.5;
export const REVIEW_SPEED_MAX = 2;

export function clampReviewSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.max(REVIEW_SPEED_MIN, Math.min(REVIEW_SPEED_MAX, speed));
}

/**
 * Базовая пауза (мс) перед переходом к следующей операции — по типу
 * текущей операции. `prefers-reduced-motion` обнуляет слайд-анимацию
 * (`animateMoveMs → 0`); холды остаются, но в reduced-motion хук
 * переходит в пошаговый режим и авто-адванс не использует.
 */
export function holdMsForOp(
  op: ReviewPlanOp,
  timings: ReviewTimings,
  reducedMotion = false,
): number {
  const animate = reducedMotion ? 0 : Math.max(0, timings.animateMoveMs);
  switch (op.type) {
    case 'move':
      return animate + Math.max(0, timings.holdMoveMs);
    case 'annotate':
      return Math.max(0, timings.holdKeyMs);
    case 'goto':
      return Math.max(0, timings.resetMs);
    default:
      return 0;
  }
}

/** Пауза с учётом множителя скорости: `base / speed`. */
export function effectiveHoldMs(baseMs: number, speed: number): number {
  return Math.max(0, baseMs / clampReviewSpeed(speed));
}

// ---------------------------------------------------------------------------
// UCI и поиск узла.
// ---------------------------------------------------------------------------

export interface ParsedUci {
  from: string;
  to: string;
  promotion?: string;
}

export function parseUci(uci: string): ParsedUci | null {
  if (typeof uci !== 'string' || uci.length < 4) return null;
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  };
}

/**
 * Поиск узла дерева по `globalIndex`. Обходит основную линию (`next`) и
 * все вариации (`variations`) — дерево иммутабельно, узел ищется заново
 * при каждом возврате к развилке (ADR §5).
 */
export function findMoveByGlobalIndex(
  history: readonly ChessMove[],
  globalIndex: number,
): ChessMove | null {
  const stack: ChessMove[] = [...history];
  const seen = new Set<ChessMove>();
  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (node.globalIndex === globalIndex) return node;
    if (node.next) stack.push(node.next);
    if (node.variations) {
      for (const variation of node.variations) stack.push(...variation);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Применение операции к review-actions.
// ---------------------------------------------------------------------------

/**
 * Минимальный контракт `useReviewState`, нужный плееру. Читатели
 * (`getHistory` / `getCurrentGlobalIndex` / `getCurrentFen`) в хуке —
 * ref-backed (всегда актуальны после последнего коммита React).
 */
export interface ReviewPlayerReviewApi {
  makeVariantMove: (from: string, to: string, promotion?: string) => boolean;
  gotoMove: (move: ChessMove) => void;
  gotoFirst: () => void;
  setNag: (globalIndex: number, nags: number[]) => void;
  setComment: (globalIndex: number, comment: string) => void;
  /** KS-4950: повысить узел до главной линии (сильнейший ход). */
  promoteVariation: (move: ChessMove) => void;
  getHistory: () => readonly ChessMove[];
  getCurrentGlobalIndex: () => number;
  getCurrentFen: () => string;
}

export interface ApplyOpContext {
  /**
   * id узла плана → globalIndex созданного узла (заполняется по мере
   * записи ходов). Навигация к развилке идёт по id, а НЕ по FEN —
   * иначе транспозиции дают неоднозначность и ход применяется не от того
   * узла.
   */
  idIndex: Map<number, number>;
  /**
   * KS-4950: globalIndex узла, из которого запущен разбор (текущая
   * позиция пользователя). goto к корню (REVIEW_ROOT_ID) возвращает
   * именно сюда, а не в начало партии. `-1` — корень = стартовая позиция.
   */
  rootGlobalIndex?: number;
}

/**
 * Применяет одну операцию плана к review-actions (ADR §5):
 *   - `goto`: к корню (REVIEW_ROOT_ID) → узел `rootGlobalIndex` (текущая
 *     позиция) через `gotoMove`, либо `gotoFirst` если корень —
 *     стартовая позиция; иначе поиск узла по `idIndex[toId]` → `gotoMove`.
 *   - `move`: `makeVariantMove` (сам решает ADD_VARIATION/ADD_MOVE/GOTO_MOVE).
 *   - `annotate`: `setNag`/`setComment` на текущем узле (уже закоммичен).
 *
 * Возвращает `true`, если операция применена (для `move` — успех
 * makeVariantMove; для goto/annotate — что нашли цель).
 */
export function applyReviewOp(
  op: ReviewPlanOp,
  review: ReviewPlayerReviewApi,
  ctx: ApplyOpContext,
): boolean {
  switch (op.type) {
    case 'goto': {
      if (op.toId === REVIEW_ROOT_ID) {
        // Возврат к корню разбора = к узлу, из которого запущен разбор
        // (текущая позиция), а не в начало партии.
        const rootGi = ctx.rootGlobalIndex ?? -1;
        if (rootGi >= 0) {
          const rootNode = findMoveByGlobalIndex(review.getHistory(), rootGi);
          if (rootNode) {
            review.gotoMove(rootNode);
            return true;
          }
        }
        review.gotoFirst();
        return true;
      }
      const gi = ctx.idIndex.get(op.toId);
      if (gi === undefined) return false;
      const node = findMoveByGlobalIndex(review.getHistory(), gi);
      if (!node) return false;
      review.gotoMove(node);
      return true;
    }
    case 'move': {
      const parsed = parseUci(op.uci);
      if (!parsed) return false;
      return review.makeVariantMove(parsed.from, parsed.to, parsed.promotion);
    }
    case 'annotate': {
      const gi = review.getCurrentGlobalIndex();
      if (gi < 0) return false;
      if (typeof op.nag === 'number') review.setNag(gi, [op.nag]);
      if (op.comment) review.setComment(gi, op.comment);
      return true;
    }
    case 'promote': {
      const gi = review.getCurrentGlobalIndex();
      if (gi < 0) return false;
      const node = findMoveByGlobalIndex(review.getHistory(), gi);
      if (!node) return false;
      review.promoteVariation(node);
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Прогресс «узел i из N».
// ---------------------------------------------------------------------------

/** Число move-операций в плане (= узлов дерева, записываемых разбором). */
export function totalReviewNodes(plan: ReviewPlan): number {
  return plan.ops.reduce((n, op) => (op.type === 'move' ? n + 1 : n), 0);
}

/**
 * Прогресс по индексу применённой операции: сколько move-операций уже
 * применено (`current`) из общего числа (`total`). `opIndex < 0` — плеер
 * ещё не стартовал (current=0).
 */
export function reviewProgress(
  plan: ReviewPlan,
  opIndex: number,
): { current: number; total: number } {
  const total = totalReviewNodes(plan);
  let current = 0;
  for (let i = 0; i <= opIndex && i < plan.ops.length; i++) {
    if (plan.ops[i].type === 'move') current += 1;
  }
  return { current, total };
}
