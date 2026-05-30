/**
 * KS-3439 / ADR-088 §11 (S2). Минимальный move-generator для blind-board:
 * 4 типа фигур (Q/R/N/B), без королей и пешек. Чистая комбинаторика,
 * без chess.js и Stockfish.
 *
 * Семантика «атака» — геометрический контроль клетки луча. Луч ладьи/
 * слона/ферзя обрывается на ПЕРВОМ препятствии; клетка препятствия
 * **входит** в множество атак (§2.1: «луч дошёл до Q → P атакует Q
 * геометрически»). Конь атакует все 8 прыжков независимо от занятости.
 *
 * Ходить можно ТОЛЬКО на пустые клетки (свои фигуры блокируют ход на
 * занятую клетку, но не атаку этой клетки — для лучей).
 */
import type {
  BlindBoardPiece,
  BlindBoardPieceType,
  BlindBoardSquare,
} from '../../types/api-contracts.js';

const FILES = 'abcdefgh';

const KNIGHT_OFFSETS: ReadonlyArray<[number, number]> = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const ROOK_DIRS: ReadonlyArray<[number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];
const BISHOP_DIRS: ReadonlyArray<[number, number]> = [
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];
const QUEEN_DIRS: ReadonlyArray<[number, number]> = [
  ...ROOK_DIRS,
  ...BISHOP_DIRS,
];

/** Координаты клетки (0..7) × (0..7) из `BlindBoardSquare`. */
export function parseSquare(sq: BlindBoardSquare): [number, number] {
  const f = FILES.indexOf(sq[0]);
  const r = parseInt(sq[1], 10) - 1;
  return [f, r];
}

/** Обратная сборка `BlindBoardSquare` из координат. Возвращает `null`
 * если вне доски — caller сам отвергает. */
export function makeSquare(f: number, r: number): BlindBoardSquare | null {
  if (f < 0 || f > 7 || r < 0 || r > 7) return null;
  return `${FILES[f]}${r + 1}` as BlindBoardSquare;
}

/** Карта позиции `square → type` для O(1) lookup. */
function positionMap(position: BlindBoardPiece[]): Map<BlindBoardSquare, BlindBoardPieceType> {
  const m = new Map<BlindBoardSquare, BlindBoardPieceType>();
  for (const p of position) m.set(p.square, p.type);
  return m;
}

function dirsFor(type: BlindBoardPieceType): ReadonlyArray<[number, number]> {
  switch (type) {
    case 'R':
      return ROOK_DIRS;
    case 'B':
      return BISHOP_DIRS;
    case 'Q':
      return QUEEN_DIRS;
    case 'N':
      // Конь обрабатывается отдельно (прыжки, не лучи).
      return [];
  }
}

/**
 * Все клетки, на которые фигура `piece` может СХОДИТЬ из своей позиции
 * с учётом препятствий (другими фигурами в `position`). Ход на клетку,
 * занятую другой фигурой, НЕ разрешён. Для лучей — до первой фигуры
 * (исключительно). Для коня — все 8 прыжков (через фигуры) кроме
 * занятых клеток. Своя клетка `piece.square` препятствием не считается.
 */
export function geometricMoves(
  piece: BlindBoardPiece,
  position: BlindBoardPiece[],
): BlindBoardSquare[] {
  const map = positionMap(position);
  const [f0, r0] = parseSquare(piece.square);
  const out: BlindBoardSquare[] = [];

  if (piece.type === 'N') {
    for (const [df, dr] of KNIGHT_OFFSETS) {
      const sq = makeSquare(f0 + df, r0 + dr);
      if (!sq) continue;
      if (map.has(sq) && sq !== piece.square) continue;
      out.push(sq);
    }
    return out;
  }

  for (const [df, dr] of dirsFor(piece.type)) {
    let f = f0 + df;
    let r = r0 + dr;
    while (true) {
      const sq = makeSquare(f, r);
      if (!sq) break;
      if (map.has(sq) && sq !== piece.square) break; // препятствие — ход запрещён, луч обрывается
      out.push(sq);
      f += df;
      r += dr;
    }
  }
  return out;
}

/**
 * Множество клеток, которые `piece` АТАКУЕТ геометрически (контролирует)
 * в позиции `position`. Для коня — все 8 прыжков (независимо от
 * занятости). Для лучей — все клетки до первой фигуры **включая** её
 * клетку (ADR-088 §2.1).
 */
export function attacks(
  piece: BlindBoardPiece,
  position: BlindBoardPiece[],
): Set<BlindBoardSquare> {
  const map = positionMap(position);
  const [f0, r0] = parseSquare(piece.square);
  const out = new Set<BlindBoardSquare>();

  if (piece.type === 'N') {
    for (const [df, dr] of KNIGHT_OFFSETS) {
      const sq = makeSquare(f0 + df, r0 + dr);
      if (sq) out.add(sq);
    }
    return out;
  }

  for (const [df, dr] of dirsFor(piece.type)) {
    let f = f0 + df;
    let r = r0 + dr;
    while (true) {
      const sq = makeSquare(f, r);
      if (!sq) break;
      out.add(sq);
      // Препятствие (другая фигура) — атакуем её клетку и луч обрывается.
      if (map.has(sq) && sq !== piece.square) break;
      f += df;
      r += dr;
    }
  }
  return out;
}

/** Кандидат хода с ровно одной вовлечённой фигурой (ADR-088 §3). */
export interface UniqueTargetMove {
  /** Клетка, куда target_piece ходит. */
  to: BlindBoardSquare;
  /** Вовлечённая фигура (не target_piece) — единственная атакует/атакована. */
  target: BlindBoardPiece;
}

/**
 * Возвращает все ходы фигуры `targetPieceSquare` в `position`, после
 * которых ровно ОДНА другая фигура оказывается «вовлечённой» (target
 * атакует её ИЛИ она атакует to). Это кандидаты хода компьютера в
 * blind-board: задача игрока — опознать `target` по `{from, to}`.
 *
 * Если `targetPieceSquare` не найдена в `position` — пустой массив.
 */
export function findUniqueTargetMoves(
  position: BlindBoardPiece[],
  targetPieceSquare: BlindBoardSquare,
): UniqueTargetMove[] {
  const target = position.find((p) => p.square === targetPieceSquare);
  if (!target) return [];

  const others = position.filter((p) => p.square !== targetPieceSquare);
  const candidates: UniqueTargetMove[] = [];

  for (const to of geometricMoves(target, position)) {
    // Симуляция: target переезжает на `to`.
    const movedPiece: BlindBoardPiece = { square: to, type: target.type };
    const newPosition: BlindBoardPiece[] = [...others, movedPiece];
    const movedAtk = attacks(movedPiece, newPosition);

    const involved: BlindBoardPiece[] = [];
    for (const Q of others) {
      const qAtk = attacks(Q, newPosition);
      if (movedAtk.has(Q.square) || qAtk.has(to)) {
        involved.push(Q);
      }
    }
    if (involved.length === 1) {
      candidates.push({ to, target: involved[0] });
    }
  }
  return candidates;
}
