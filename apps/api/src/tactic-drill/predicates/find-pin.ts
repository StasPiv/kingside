/**
 * KS-2227 / ADR-035 §2.1 #3 — `find-pin` (абсолютные и относительные
 * связки).
 *
 * KS-2336/KS-2340: уточнённая семантика. Связкой считается фигура P,
 * у которой выполнены оба условия:
 *   1. За P (в направлении от sliding-attacker'а противника через P)
 *      первая встреченная фигура — своя, и её ценность > ценности P
 *      (либо это король; ценность короля = Infinity, абсолютная связка).
 *   2. Существует хотя бы один pseudo-legal ход P, не лежащий на
 *      прямой (attacker, anchor). Это значит — P может физически
 *      сойти с линии связки и открыть anchor.
 *
 * KS-2347: расширение с абсолютных связок (anchor=king) на
 * относительные (anchor=ферзь/ладья/слон/конь, ценнее P).
 *
 * KS-2455: чистые геометрические helpers (`findPinAnchor`,
 * `pseudoTargets`, `existsTargetOffPinLine`) вынесены в
 * `@kingside/shared/chess/pin` для переиспользования frontend
 * explanation-engine'ом (KS-2454-ENGINE). Логика и результаты не
 * изменились — predicate тонкая обёртка с piece-value фильтром и
 * strict-uniqueness'ом.
 */

import type { Square as ChessJsSquare } from 'chess.js';
import type { AnswerSquare } from '@kingside/shared';
import {
  findPinAnchor,
  existsTargetOffPinLine,
  type PinPieceType,
} from '@kingside/shared';
import { allPieces, PIECE_VALUE, tryLoadChess, type SquareResult } from './types';

export function findPin(fen: string): SquareResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const candidates: string[] = [];

  for (const p of allPieces(chess)) {
    if (p.type === 'k') continue;

    // KS-2347: anchor может быть и не король, главное — ценность > P.
    const anchor = findPinAnchor(
      chess,
      p.square as ChessJsSquare,
      p.color,
    );
    if (!anchor) continue;

    const pValue = PIECE_VALUE[p.type] ?? 0;
    const aValue = PIECE_VALUE[anchor.anchorType] ?? 0;
    if (aValue <= pValue) continue; // равная ценность — не связка

    if (
      !existsTargetOffPinLine(
        chess,
        p.square as ChessJsSquare,
        p.type as PinPieceType,
        p.color,
        anchor.sliderSq,
        anchor.anchorSq,
      )
    ) {
      continue;
    }

    candidates.push(p.square);
  }

  if (candidates.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly 1 pinned piece, found ${candidates.length}`,
    };
  }

  const answer: AnswerSquare = { shape: 'square', square: candidates[0] };
  return { valid: true, answer };
}
