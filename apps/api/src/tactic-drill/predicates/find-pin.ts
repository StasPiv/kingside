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
 * Реализация п.2 (KS-2340 — переписана с KS-2336): chess.js v1 не
 * отдаёт pseudo-legal ходы, попадающие под собственный шах. Поэтому
 * мы геометрически генерируем pseudo-legal targets фигуры P в
 * исходной позиции (с учётом доски и своих фигур, без учёта связки)
 * и для каждого target проверяем — лежит ли он на прямой
 * (attacker, king) через P. Если хотя бы один target НЕ на этой
 * прямой — ход открывает короля → P связана. Если все на прямой
 * (или их нет вообще, как у пешки g7 с ладьёй g6 рядом — ходы
 * физически заблокированы) — P не связана.
 *
 * Важно: предыдущий KS-2336 фикс «удалять attacker и брать moves»
 * давал false-positive для пешки g7 при белой ладье g6 — после
 * удаления ладьи у пешки появлялись фиктивные ходы g7-g6/g7-g5,
 * которых в реальной позиции нет.
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

type PieceType = 'p' | 'n' | 'b' | 'r' | 'q';

/**
 * KS-2340: pseudo-legal targets фигуры в **исходной** позиции, без
 * учёта связки (chess.js фильтрует ходы, открывающие короля; нам же
 * нужны все геометрически возможные ходы). Учитывает доску, свои
 * фигуры, тип хода для каждой не-королевской фигуры.
 *
 * Не возвращает en-passant (упрощение: pawn-капчи только если на
 * клетке стоит вражеская фигура). Promotion не различается — нас
 * интересует только клетка target.
 */
function pseudoTargets(
  chess: Chess,
  sq: ChessJsSquare,
  type: PieceType,
  color: 'w' | 'b',
): ChessJsSquare[] {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  const enemy = color === 'w' ? 'b' : 'w';
  const out: ChessJsSquare[] = [];

  const squareAt = (f: number, r: number): ChessJsSquare | null => {
    if (f < 0 || f > 7 || r < 0 || r > 7) return null;
    return (String.fromCharCode(97 + f) + (r + 1)) as ChessJsSquare;
  };

  if (type === 'p') {
    const dir = color === 'w' ? 1 : -1;
    const startRank = color === 'w' ? 1 : 6;
    const f1 = squareAt(file, rank + dir);
    if (f1 && !chess.get(f1)) out.push(f1);
    const f2 = squareAt(file, rank + 2 * dir);
    if (rank === startRank && f1 && f2 && !chess.get(f1) && !chess.get(f2)) {
      out.push(f2);
    }
    for (const dx of [-1, 1]) {
      const c = squareAt(file + dx, rank + dir);
      if (!c) continue;
      const t = chess.get(c);
      if (t && t.color === enemy) out.push(c);
    }
    return out;
  }

  if (type === 'n') {
    for (const [dx, dy] of [
      [1, 2], [1, -2], [-1, 2], [-1, -2],
      [2, 1], [2, -1], [-2, 1], [-2, -1],
    ]) {
      const c = squareAt(file + dx, rank + dy);
      if (!c) continue;
      const t = chess.get(c);
      if (t && t.color === color) continue;
      out.push(c);
    }
    return out;
  }

  // sliding (b/r/q): идём по лучам до первой фигуры (включаем её
  // если вражеская, исключаем если своя).
  const dirs: Array<[number, number]> = [];
  if (type === 'r' || type === 'q') dirs.push([0, 1], [0, -1], [1, 0], [-1, 0]);
  if (type === 'b' || type === 'q') dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
  for (const [dx, dy] of dirs) {
    let f = file + dx;
    let r = rank + dy;
    while (true) {
      const c = squareAt(f, r);
      if (!c) break;
      const t = chess.get(c);
      if (!t) {
        out.push(c);
      } else {
        if (t.color === enemy) out.push(c);
        break;
      }
      f += dx;
      r += dy;
    }
  }
  return out;
}

/**
 * KS-2340: P связана если у неё есть pseudo-legal target, который
 * **не лежит** на прямой (attacker, king) через P. Если targets
 * пусты (фигура физически заблокирована, как пешка g7 при ладье g6
 * вплотную) — не связана. Если все targets на прямой связки (как
 * пешка c7 при ладье c1) — тоже не связана.
 *
 * Прямая (attacker, king) проходит через P (мы знаем это из 1-го
 * фильтра — иначе attacker не атаковал бы king'а после remove(P)).
 * Cross product 2D-векторов = 0 ⇔ collinear.
 */
function existsTargetOffPinLine(
  chess: Chess,
  pSq: ChessJsSquare,
  pType: PieceType,
  pColor: 'w' | 'b',
  attackerSq: ChessJsSquare,
  kingSq: ChessJsSquare,
): boolean {
  const targets = pseudoTargets(chess, pSq, pType, pColor);
  if (targets.length === 0) return false;
  const ux = kingSq.charCodeAt(0) - attackerSq.charCodeAt(0);
  const uy = parseInt(kingSq[1], 10) - parseInt(attackerSq[1], 10);
  for (const t of targets) {
    const vx = t.charCodeAt(0) - pSq.charCodeAt(0);
    const vy = parseInt(t[1], 10) - parseInt(pSq[1], 10);
    if (ux * vy - uy * vx !== 0) return true;
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

    // KS-2336/KS-2340: достаточное условие — у P есть pseudo-legal
    // target, не лежащий на прямой (attacker, king). Геометрический
    // generator не плодит фиктивных ходов, как было при «удалить
    // attacker → moves».
    if (
      !existsTargetOffPinLine(
        chess,
        p.square as ChessJsSquare,
        p.type as PieceType,
        p.color,
        attackerSq,
        kingSq,
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
