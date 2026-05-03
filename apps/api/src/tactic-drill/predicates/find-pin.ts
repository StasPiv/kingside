/**
 * KS-2227 / ADR-035 §2.1 #3 — `find-pin` (абсолютные связки).
 *
 * Алгоритм: для каждой не-королевской фигуры P цвета C на клетке sq:
 *   1. Запоминаем — атакуется ли king(C) до удаления P (если да — там
 *      шах, не связка; пропускаем).
 *   2. Снимаем P с доски (через `chess.remove(sq)`), проверяем
 *      `chess.attackers(king(C), oppColor(C))`. Если среди атакующих
 *      появилась дальнобойная фигура (q/r/b), которой не было раньше —
 *      P связана.
 *   3. Возвращаем P на место.
 *
 * Дальнобойные ферзь/ладья/слон бьют через клетку P только тогда, когда
 * её сняли — это и есть условие абсолютной связки. Связки на короля,
 * относительные связки (на ферзя и т.п.) — не в MVP (KS-2223 §2.2).
 *
 * В позиции должна быть **ровно одна** связанная фигура, иначе drop.
 *
 * Сторона на ходу не важна: показываем связанные фигуры обоих цветов.
 *
 * Замечание по реализации. Мутируем рабочий `Chess`-инстанс через
 * remove/put; восстанавливаем после каждого тестового удаления, чтобы
 * не плодить новые `new Chess(fen)` (тяжело для индексатора, который
 * прогонит миллионы позиций). Если `put` не удался по любой причине —
 * пересоздаём из исходного FEN (защита от случайного state-corruption).
 */

import type { Square as ChessJsSquare } from 'chess.js';
import type { AnswerSquare } from '@kingside/shared';
import { Chess } from 'chess.js';
import {
  allPieces,
  findKingSquare,
  oppColor,
  tryLoadChess,
  type SquareResult,
} from './types';

const SLIDING: ReadonlySet<string> = new Set(['q', 'r', 'b']);

function attackerTypes(chess: Chess, sq: ChessJsSquare, byColor: 'w' | 'b'): Set<string> {
  const out = new Set<string>();
  for (const a of chess.attackers(sq, byColor)) {
    const piece = chess.get(a);
    if (piece) out.add(piece.type);
  }
  return out;
}

export function findPin(fen: string): SquareResult {
  let chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const candidates: string[] = [];

  for (const p of allPieces(chess)) {
    if (p.type === 'k') continue;

    const kingSq = findKingSquare(chess, p.color);
    if (!kingSq) continue; // невалидная позиция без короля — пропускаем

    const enemy = oppColor(p.color);
    const before = attackerTypes(chess, kingSq, enemy);

    chess.remove(p.square);
    const after = attackerTypes(chess, kingSq, enemy);

    // Восстанавливаем доску. `put` может вернуть false (например, если
    // движок сочтёт state corrupted); в таком случае пересоздаём
    // инстанс из исходного FEN.
    let putOk = false;
    try {
      putOk = chess.put({ type: p.type, color: p.color }, p.square);
    } catch {
      putOk = false;
    }
    if (!putOk) {
      const restored = tryLoadChess(fen);
      if (!restored) return { valid: false, reason: 'fen_state_corrupted' };
      chess = restored;
    }

    // Появилась дальнобойная атака на king'а после удаления P → связка.
    let newSliding = false;
    for (const t of after) {
      if (!before.has(t) && SLIDING.has(t)) {
        newSliding = true;
        break;
      }
    }
    if (newSliding) candidates.push(p.square);
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
