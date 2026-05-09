/**
 * KS-2227 / ADR-035 §2.1 #3 — `find-pin` (абсолютные и относительные
 * связки).
 *
 * KS-2615: возвращена классическая шахматная семантика связки. Связкой
 * считается фигура P, у которой:
 *   1. За P (в направлении от sliding-attacker'а противника через P)
 *      первая встреченная фигура — своя, и её ценность > ценности P
 *      (либо это король; ценность короля = Infinity, абсолютная связка).
 *
 * Условие KS-2336/KS-2340 «существует ход P, уводящий с линии связки»
 * сняли: пользователи и шахматные тренажёры считают связкой и тот
 * случай, когда фигура двигается только вдоль линии (классический
 * пример — пешка d6 на колонке атакующей ладьи d1 с конём d7 за ней;
 * pseudo-targets пешки = `d5`, остаётся на колонке, но позиция всё
 * равно — связка). Старая семантика отсекала такие случаи и плодила
 * ложные «d6 не связана» в тренажёре определения связок (KS-2615 + см.
 * KS-2597 — диагональный аналог).
 *
 * KS-2347: anchor может быть и не король — ферзь/ладья/слон/конь,
 * ценнее P (относительная связка с материальной выгодой).
 *
 * KS-2455: чистые геометрические helpers (`findPinAnchor`,
 * `pseudoTargets`, `existsTargetOffPinLine`) лежат в
 * `@kingside/shared/chess/pin`. `existsTargetOffPinLine` сохранён как
 * самостоятельный helper (используется фронтовым explanation-движком),
 * predicate его больше не вызывает.
 */

import type { Square as ChessJsSquare } from 'chess.js';
import type { AnswerSquare } from '@kingside/shared';
import { findPinAnchor } from '@kingside/shared';
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
    if (aValue <= pValue) continue; // равная или меньшая ценность — не связка

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
