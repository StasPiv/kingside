/**
 * KS-2227 / KS-2399 / KS-2400 / KS-2406 / KS-2408 / KS-2455.
 *
 * Pure-функция: вычисляет clean fork-цели после применения хода.
 *
 * «Новая вилка» (KS-2408): после хода `m` существует наша фигура F
 * с ≥2 ценными целями противника под боем, причём ни одна из этих
 * целей не входит в множество того, что **тот же форкер** атаковал
 * до хода. Соответствие «тот же форкер» по клетке: для ходящей фигуры
 * старая клетка = `m.from`, новая = `m.to`; для discovered-форкера
 * (фигура не двигалась) старая = новая = его текущая клетка.
 *
 * Этот helper НЕ выполняет safety-check атакующей фигуры (KS-2406) —
 * это семантика более высокого уровня (predicate решает, считать ли
 * unsafe-форкера ответом). Helper отдаёт clean fork при первом
 * найденном — любой clean-форкер пригоден для UI/explanation.
 *
 * «Ценные» = `n/b/r/q/k` (PIECE_VALUE ≥ 3). Пешки исключены.
 *
 * Перенесено из `apps/api/src/tactic-drill/predicates/find-fork.ts` в
 * shared (KS-2455) для использования из backend predicate'а и
 * frontend explanation-engine (KS-2454-ENGINE).
 */

import { Chess, type Color } from 'chess.js';

const PIECE_VALUE: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: Infinity,
};

const VALUABLE_THRESHOLD = 3;

export interface ForkResult {
  /** Клетка фигуры, создающей вилку (после применения хода). */
  forkerSq: string;
  /** Клетки enemy-фигур, попавших под боя форкера (≥ 2). */
  targets: string[];
}

export interface ForkMoveInput {
  from: string;
  to: string;
  promotion?: string;
}

/**
 * Для каждой нашей фигуры — множество клеток ценных enemy-фигур,
 * которые она атакует прямо сейчас (без учёта пинов; chess.attackers
 * сам учитывает геометрию текущей позиции).
 */
function collectAttacksByPiece(
  chess: Chess,
  our: Color,
  enemy: Color,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const board = chess.board();
  for (const row of board) {
    for (const piece of row) {
      if (!piece) continue;
      if (piece.color !== enemy) continue;
      if (PIECE_VALUE[piece.type] < VALUABLE_THRESHOLD) continue;
      const attackers = chess.attackers(piece.square, our);
      for (const fSq of attackers) {
        if (!out.has(fSq)) out.set(fSq, new Set());
        out.get(fSq)!.add(piece.square);
      }
    }
  }
  return out;
}

export interface ForkAnalysis {
  /** Clean fork-форкер (≥ 2 целей, intersection с before = ∅) или null. */
  clean: ForkResult | null;
  /**
   * `true`, если хотя бы у одной нашей фигуры в позиции после хода
   * |targets| ≥ 2, но множество targets пересекается с тем, что
   * фигура атаковала до хода. Используется backend predicate'ом
   * `find-fork` для отдельного reason'а `overlap-with-previous-
   * attacks` (KS-2408). Для UI/explanation полезен как сигнал «вилка
   * как-бы есть, но она overlap».
   */
  hasOverlap: boolean;
}

/**
 * Полный анализ применения хода с точки зрения вилки. Возвращает clean
 * fork-результат (если удалось найти) и флаг overlap'а — было ли в
 * позиции after хотя бы одно множество targets ≥ 2, пересекающееся с
 * targets'ами того же форкера до хода.
 *
 * Помещает chess в исходное состояние (`undo`) перед возвратом.
 */
export function computeForkAnalysisAfterMove(
  fen: string,
  move: ForkMoveInput,
): ForkAnalysis {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return { clean: null, hasOverlap: false };
  }
  const our = chess.turn();
  const enemy: Color = our === 'w' ? 'b' : 'w';

  const attacksBefore = collectAttacksByPiece(chess, our, enemy);

  try {
    chess.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion,
    });
  } catch {
    return { clean: null, hasOverlap: false };
  }

  const attacksAfter = collectAttacksByPiece(chess, our, enemy);

  let clean: ForkResult | null = null;
  let hasOverlap = false;
  for (const [forkerSq, targets] of attacksAfter) {
    if (targets.size < 2) continue;
    // KS-2408: соответствие «тот же форкер» по клетке. Ходящая фигура
    // изменила клетку m.from → m.to; discovered не двигался.
    const oldSquare = forkerSq === move.to ? move.from : forkerSq;
    const before = attacksBefore.get(oldSquare);
    let overlap = false;
    if (before) {
      for (const t of targets) {
        if (before.has(t)) {
          overlap = true;
          break;
        }
      }
    }
    if (overlap) {
      hasOverlap = true;
    } else if (!clean) {
      clean = { forkerSq, targets: Array.from(targets) };
      // Не break: продолжаем сканировать, чтобы зафиксировать
      // hasOverlap по другим форкерам, если есть.
    }
  }

  chess.undo();
  return { clean, hasOverlap };
}

/**
 * Применяет ход к позиции, ищет clean fork: фигуру с ≥ 2 ценными
 * целями, не пересекающимися с тем, что та же фигура атаковала до хода.
 *
 * Возвращает первый найденный clean-форкер (с массивом целей) либо
 * `null`, если ни один такой не возник или ход некорректен.
 *
 * Тонкая обёртка над `computeForkAnalysisAfterMove` (KS-2455).
 */
export function computeForkTargetsAfterMove(
  fen: string,
  move: ForkMoveInput,
): ForkResult | null {
  return computeForkAnalysisAfterMove(fen, move).clean;
}
