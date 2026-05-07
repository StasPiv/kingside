/**
 * KS-2227 / KS-2336 / KS-2340 / KS-2347 / KS-2455.
 *
 * Pure-функции поиска связки (pin): анализ направлений «attacker→pinned→
 * anchor», pseudo-legal targets фигуры в исходной позиции, проверка
 * «есть ли target вне линии связки». Перенесено один-в-один из
 * `apps/api/src/tactic-drill/predicates/find-pin.ts` (KS-2455).
 *
 * Используется backend predicate'ом `find-pin` и frontend explanation-
 * engine'ом (KS-2454-ENGINE) — единый источник истины для алгоритма.
 *
 * Зависимость от `chess.js` оставлена явной: тип `Chess` приходит как
 * аргумент, helper не создаёт инстанс — потребитель сам управляет
 * жизненным циклом.
 */

import type { Chess, Square as ChessJsSquare } from 'chess.js';

export type PinDir = 'rook' | 'bishop';

const DIRECTIONS: Array<[df: number, dr: number, kind: PinDir]> = [
  [0, 1, 'rook'],
  [0, -1, 'rook'],
  [1, 0, 'rook'],
  [-1, 0, 'rook'],
  [1, 1, 'bishop'],
  [1, -1, 'bishop'],
  [-1, 1, 'bishop'],
  [-1, -1, 'bishop'],
];

function squareAt(file: number, rank: number): ChessJsSquare | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return (String.fromCharCode(97 + file) + (rank + 1)) as ChessJsSquare;
}

function isSlider(pieceType: string, dir: PinDir): boolean {
  if (pieceType === 'q') return true;
  if (pieceType === 'r' && dir === 'rook') return true;
  if (pieceType === 'b' && dir === 'bishop') return true;
  return false;
}

export interface PinAnchor {
  sliderSq: ChessJsSquare;
  anchorSq: ChessJsSquare;
  anchorType: string;
  /** Направление линии связки: единичный вектор от slider к anchor. */
  dx: number;
  dy: number;
}

/**
 * Геометрический поиск anchor'а для возможной связки фигуры P.
 *
 * Идём по 8 направлениям от P. По каждому:
 *   - В сторону `dir` ищем первую фигуру → если это enemy slider
 *     (Q/R/B соответствующего типа линии) → есть кандидат-attacker.
 *   - В сторону `-dir` (от P назад) ищем первую фигуру → если это
 *     своя фигура → она anchor. Если первая встреченная — enemy,
 *     anchor отсутствует (за P в обратную сторону стоит враг,
 *     не имеет смысла «защищать» его связкой).
 *
 * Возвращаем первый найденный (любая 1 связка). Если ни одной —
 * `null`.
 */
export function findPinAnchor(
  chess: Chess,
  pSq: ChessJsSquare,
  pColor: 'w' | 'b',
): PinAnchor | null {
  const enemy: 'w' | 'b' = pColor === 'w' ? 'b' : 'w';
  const file = pSq.charCodeAt(0) - 97;
  const rank = parseInt(pSq[1], 10) - 1;

  for (const [dx, dy, kind] of DIRECTIONS) {
    // 1) Идём от P в сторону (dx, dy), ищем enemy-slider.
    let sliderSq: ChessJsSquare | null = null;
    {
      let f = file + dx;
      let r = rank + dy;
      while (true) {
        const cell = squareAt(f, r);
        if (!cell) break;
        const piece = chess.get(cell);
        if (piece) {
          if (piece.color === enemy && isSlider(piece.type, kind)) {
            sliderSq = cell;
          }
          break;
        }
        f += dx;
        r += dy;
      }
    }
    if (!sliderSq) continue;

    // 2) Идём от P в обратную сторону (-dx, -dy), ищем anchor.
    let anchorSq: ChessJsSquare | null = null;
    let anchorType: string | null = null;
    {
      let f = file - dx;
      let r = rank - dy;
      while (true) {
        const cell = squareAt(f, r);
        if (!cell) break;
        const piece = chess.get(cell);
        if (piece) {
          if (piece.color === pColor) {
            anchorSq = cell;
            anchorType = piece.type;
          }
          break; // enemy или our — стоп в любом случае
        }
        f -= dx;
        r -= dy;
      }
    }
    if (!anchorSq || !anchorType) continue;

    return {
      sliderSq,
      anchorSq,
      anchorType,
      dx,
      dy,
    };
  }

  return null;
}

export type PinPieceType = 'p' | 'n' | 'b' | 'r' | 'q';

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
export function pseudoTargets(
  chess: Chess,
  sq: ChessJsSquare,
  type: PinPieceType,
  color: 'w' | 'b',
): ChessJsSquare[] {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  const enemy = color === 'w' ? 'b' : 'w';
  const out: ChessJsSquare[] = [];

  const sqAt = (f: number, r: number): ChessJsSquare | null => {
    if (f < 0 || f > 7 || r < 0 || r > 7) return null;
    return (String.fromCharCode(97 + f) + (r + 1)) as ChessJsSquare;
  };

  if (type === 'p') {
    const dir = color === 'w' ? 1 : -1;
    const startRank = color === 'w' ? 1 : 6;
    const f1 = sqAt(file, rank + dir);
    if (f1 && !chess.get(f1)) out.push(f1);
    const f2 = sqAt(file, rank + 2 * dir);
    if (rank === startRank && f1 && f2 && !chess.get(f1) && !chess.get(f2)) {
      out.push(f2);
    }
    for (const dx of [-1, 1]) {
      const c = sqAt(file + dx, rank + dir);
      if (!c) continue;
      const t = chess.get(c);
      if (t && t.color === enemy) out.push(c);
    }
    return out;
  }

  if (type === 'n') {
    for (const [dx, dy] of [
      [1, 2],
      [1, -2],
      [-1, 2],
      [-1, -2],
      [2, 1],
      [2, -1],
      [-2, 1],
      [-2, -1],
    ]) {
      const c = sqAt(file + dx, rank + dy);
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
  if (type === 'b' || type === 'q')
    dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
  for (const [dx, dy] of dirs) {
    let f = file + dx;
    let r = rank + dy;
    while (true) {
      const c = sqAt(f, r);
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
 * KS-2340: P связана если у неё есть pseudo-legal target, не лежащий
 * на прямой (attacker, anchor). Прямая (attacker, anchor) проходит
 * через P (по построению `findPinAnchor`). Cross product 2D = 0 ⇔
 * collinear.
 */
export function existsTargetOffPinLine(
  chess: Chess,
  pSq: ChessJsSquare,
  pType: PinPieceType,
  pColor: 'w' | 'b',
  attackerSq: ChessJsSquare,
  anchorSq: ChessJsSquare,
): boolean {
  const targets = pseudoTargets(chess, pSq, pType, pColor);
  if (targets.length === 0) return false;
  const ux = anchorSq.charCodeAt(0) - attackerSq.charCodeAt(0);
  const uy = parseInt(anchorSq[1], 10) - parseInt(attackerSq[1], 10);
  for (const t of targets) {
    const vx = t.charCodeAt(0) - pSq.charCodeAt(0);
    const vy = parseInt(t[1], 10) - parseInt(pSq[1], 10);
    if (ux * vy - uy * vx !== 0) return true;
  }
  return false;
}
