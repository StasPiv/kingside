/**
 * KS-2227 / ADR-035 §2.1 #7 — `count-attackers`.
 *
 * Алгоритм: для подсвеченной клетки `targetSquare` посчитать число
 * фигур цвета `attackerColor`, атакующих эту клетку.
 *
 * Поведение для индексатора:
 *   - сам предикат `countAttackers(fen, square, color)` отдаёт answer
 *     ровно для одной (square, color)-пары.
 *   - дополнительный helper `findCountAttackersCandidates(fen)`
 *     перебирает все 64 клетки × 2 цвета и собирает все валидные
 *     drill-варианты (в одной FEN их может быть много — это норма;
 *     индексатор пишет каждый кандидат как отдельный drill).
 *
 * AnswerNumber.value ∈ [1, 4] (api-contract §3.3 — на UI 4 кнопки).
 * Случаи `attackers(sq).length === 0` или `> 4` отбрасываются.
 */

import type { Color, Square as ChessJsSquare } from 'chess.js';
import type { AnswerNumber } from '@kingside/shared';
import {
  ALL_SQUARES,
  tryLoadChess,
  type NumberResult,
} from './types';

const MIN_VALUE = 1;
const MAX_VALUE = 4;

export function countAttackers(
  fen: string,
  targetSquare: ChessJsSquare,
  attackerColor: Color,
): NumberResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const value = chess.attackers(targetSquare, attackerColor).length;
  if (value < MIN_VALUE || value > MAX_VALUE) {
    return {
      valid: false,
      reason: `attackers count ${value} outside [${MIN_VALUE},${MAX_VALUE}]`,
    };
  }

  const answer: AnswerNumber = { shape: 'number', value };
  return { valid: true, answer };
}

/**
 * Кандидат для `count-attackers`-drill: какая клетка подсвечивается и
 * для какого цвета атакующих считается ответ. Используется индексатором
 * (KS-DRILL-INDEXER) для генерации всех drill'ов из одной FEN.
 */
export interface CountAttackersCandidate {
  targetSquare: ChessJsSquare;
  attackerColor: Color;
  answer: AnswerNumber;
}

export function findCountAttackersCandidates(
  fen: string,
): CountAttackersCandidate[] {
  const chess = tryLoadChess(fen);
  if (!chess) return [];

  const out: CountAttackersCandidate[] = [];
  for (const sq of ALL_SQUARES) {
    for (const color of ['w', 'b'] as const) {
      const value = chess.attackers(sq, color).length;
      if (value >= MIN_VALUE && value <= MAX_VALUE) {
        out.push({
          targetSquare: sq,
          attackerColor: color,
          answer: { shape: 'number', value },
        });
      }
    }
  }
  return out;
}
