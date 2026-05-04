/**
 * KS-2227 / ADR-035 §2.1 #3 — `find-pin` (абсолютные связки).
 *
 * KS-2336: уточнённая семантика. Связкой считается фигура P, у которой
 * выполнены оба условия:
 *   1. После виртуального удаления P король цвета P попадает под атаку
 *      дальнобойной фигуры противника (Q/R/B), которой не было до
 *      удаления.
 *   2. **Существует хотя бы один pseudo-legal ход P**, после которого
 *      король P цвета остаётся под атакой этой дальнобойной фигуры
 *      (т. е. ход уводит P с защищающей линии).
 *
 * До KS-2336 алгоритм проверял только п.1. Это давало завышение:
 * например, чёрная пешка g7 при чёрном короле g8 и белом ферзе g3 —
 * после удаления пешки король под боем, но все ходы пешки (g6/g5)
 * остаются на g-вертикали и не открывают короля. По шахматной
 * семантике она не связана; теперь predicate её отфильтрует.
 *
 * Реализация п.2: chess.js v1 не отдаёт pseudo-legal ходы, попадающие
 * под собственный шах (он их фильтрует как illegal). Поэтому мы:
 *   a) находим attacker — sliding piece, появившуюся в attackers(king)
 *      после remove(P);
 *   b) убираем attacker из копии позиции и переключаем turn на P.color;
 *   c) `chess.moves({ square: P.square })` теперь даёт pseudo-legal
 *      ходы P относительно связки (без attacker'а они становятся
 *      legal);
 *   d) для каждого хода в клоне — применяем move, возвращаем attacker
 *      на место, проверяем `attackers(kingP, oppColor(P.color))` на
 *      содержание клетки attacker'а; если да — этот ход открывает
 *      короля → P связана.
 *
 * В позиции должна быть **ровно одна** связанная фигура, иначе drop.
 *
 * Сторона на ходу не важна: показываем связанные фигуры обоих цветов.
 *
 * Замечание по реализации. Основной обход мутирует рабочий `Chess`-
 * инстанс через remove/put; восстанавливаем после каждого тестового
 * удаления, чтобы не плодить новые `new Chess(fen)` для миллионов
 * позиций индексера. Симуляция ходов P (KS-2336) делается на отдельных
 * клонах через `new Chess(fen)` — её гонка ограничена реальными
 * кандидатами связки (≤ 1 на типичной позиции).
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

function findNewSlidingAttackerSq(
  chess: Chess,
  kingSq: ChessJsSquare,
  byColor: 'w' | 'b',
  beforeSet: Set<ChessJsSquare>,
): ChessJsSquare | null {
  for (const a of chess.attackers(kingSq, byColor)) {
    if (beforeSet.has(a)) continue;
    const piece = chess.get(a);
    if (piece && SLIDING.has(piece.type)) return a;
  }
  return null;
}

/**
 * KS-2336: проверка существования pseudo-legal хода P, после которого
 * король P-цвета остаётся под атакой `attackerSq`. Возвращает true
 * если такой ход найден.
 */
function existsMoveOpeningKing(
  baseFen: string,
  pSq: ChessJsSquare,
  pColor: 'w' | 'b',
  attackerSq: ChessJsSquare,
): boolean {
  const baseChess = tryLoadChess(baseFen);
  if (!baseChess) return false;
  const attackerPiece = baseChess.get(attackerSq);
  if (!attackerPiece) return false;

  // 1. Удаляем атакера, переключаем turn на P.color → у P становятся
  //    «pseudo-legal в смысле связки» ходы (они теперь legal без атакера).
  const fenParts = baseChess.fen().split(' ');
  baseChess.remove(attackerSq);
  const fenNoAttacker = baseChess.fen().split(' ');
  fenNoAttacker[1] = pColor;
  // Сбросим castling/en-passant до значений, безопасных для нашей
  // проверки (нам не нужны кастлинги; en-passant может ввести лишние
  // ходы пешки, но они тоже валидные pseudo-legal moves в смысле связки).
  void fenParts; // оставляем для возможного debug
  const fenForP = fenNoAttacker.join(' ');

  let cTmp: Chess;
  try {
    cTmp = new Chess(fenForP);
  } catch {
    return false;
  }

  const moves = cTmp.moves({ square: pSq, verbose: true });
  if (moves.length === 0) return false;

  for (const m of moves) {
    let c2: Chess;
    try {
      c2 = new Chess(cTmp.fen());
    } catch {
      continue;
    }
    try {
      c2.move({ from: m.from, to: m.to, promotion: m.promotion });
    } catch {
      continue;
    }
    let putOk = false;
    try {
      putOk = c2.put(attackerPiece, attackerSq);
    } catch {
      putOk = false;
    }
    if (!putOk) continue;

    const kingSq = findKingSquare(c2, pColor);
    if (!kingSq) continue;
    const attackers = c2.attackers(kingSq, oppColor(pColor));
    if (attackers.includes(attackerSq)) return true;
  }
  return false;
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
    const beforeSquares = new Set<ChessJsSquare>(
      chess.attackers(kingSq, enemy),
    );

    chess.remove(p.square);
    const after = attackerTypes(chess, kingSq, enemy);
    const attackerSq = findNewSlidingAttackerSq(
      chess,
      kingSq,
      enemy,
      beforeSquares,
    );

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

    // Появилась дальнобойная атака на king'а после удаления P → связка
    // (необходимое условие KS-2227).
    let newSliding = false;
    for (const t of after) {
      if (!before.has(t) && SLIDING.has(t)) {
        newSliding = true;
        break;
      }
    }
    if (!newSliding || !attackerSq) continue;

    // KS-2336: достаточное условие — хотя бы один pseudo-legal ход P
    // открывает короля. Если все ходы остаются на линии связки, фигура
    // фактически свободна и не считается связанной.
    if (!existsMoveOpeningKing(fen, p.square, p.color, attackerSq)) continue;

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
