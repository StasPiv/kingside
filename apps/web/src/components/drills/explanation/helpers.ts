/**
 * KS-2456. Вспомогательные функции для explanation-движка.
 *
 * - `oppColor` — противоположный цвет.
 * - `pieceValue` — стандартная шахматная ценность фигуры (для
 *   absolute/relative pin и для «ценных» фигур fork).
 * - `pieceLabelKey` — ключ i18n для названия фигуры (`chess.pieces.*`).
 * - `formatSquareList` — строка «e4, f3, d3» для notes.
 * - `iterAllSquares` — итератор по всем 64 клеткам.
 */
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';

export function oppColor(c: Color): Color {
  return c === 'w' ? 'b' : 'w';
}

/**
 * Ценность фигуры по стандартной шкале (Reinfeld). King — Infinity (для
 * absolute pin). Используется только для сравнения «ценнее ли anchor
 * чем pinned» — конкретные числа неважны, важен порядок.
 */
export function pieceValue(type: PieceSymbol): number {
  switch (type) {
    case 'p': return 1;
    case 'n': return 3;
    case 'b': return 3;
    case 'r': return 5;
    case 'q': return 9;
    case 'k': return Number.POSITIVE_INFINITY;
  }
}

/**
 * i18n-ключ названия фигуры. Соглашение: `chess.pieces.king`,
 * `chess.pieces.queen` и т.д. (используется в нотках explanation для
 * подстановки `{piece}`). Для пешек — `chess.pieces.pawn`.
 */
export function pieceLabelKey(type: PieceSymbol): string {
  switch (type) {
    case 'p': return 'chess.pieces.pawn';
    case 'n': return 'chess.pieces.knight';
    case 'b': return 'chess.pieces.bishop';
    case 'r': return 'chess.pieces.rook';
    case 'q': return 'chess.pieces.queen';
    case 'k': return 'chess.pieces.king';
  }
}

/** "e4, f3, d3" — для подстановки в notes (`{pieces}`/`{moves}`/…). */
export function formatSquareList(squares: string[]): string {
  return squares.join(', ');
}

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;

/**
 * Итерирует все 64 клетки доски в порядке a1..h8 (file outer, rank inner).
 * Клетки приведены к chess.js-типу `Square` (литерал).
 */
export function iterAllSquares(): Square[] {
  const out: Square[] = [];
  for (const f of FILES) {
    for (const r of RANKS) {
      out.push((f + r) as Square);
    }
  }
  return out;
}

/** Извлечь side-to-move из FEN; null при кривом FEN. */
export function sideFromFen(fen: string): Color | null {
  const parts = fen.split(' ');
  if (parts.length < 2) return null;
  const side = parts[1];
  return side === 'w' || side === 'b' ? side : null;
}

/** Сравнить два массива клеток как множества. */
export function squareSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const x of b) if (!setA.has(x)) return false;
  return true;
}

/**
 * KS-2482: получить SAN-нотацию для хода `{from, to, promotion?}` в
 * позиции `fen`. Pure-функция: создаёт временный Chess-инстанс,
 * применяет ход и возвращает `move.san` (`Qb2`, `Nf3`, `Bxa6`, `O-O`).
 *
 * Если ход не легален в позиции (что для drill'ов — аномалия) или FEN
 * кривой, возвращаем UCI-склейку `from + to` как fallback — UI не
 * упадёт, но текст будет менее красивым, и проблема будет видна в
 * notes.
 */
export function moveToSan(
  fen: string,
  from: string,
  to: string,
  promotion?: 'q' | 'r' | 'b' | 'n',
): string {
  try {
    const c = new Chess(fen);
    const m = c.move({
      from: from as Square,
      to: to as Square,
      ...(promotion ? { promotion } : {}),
    });
    if (m && m.san) return m.san;
  } catch {
    /* fall through */
  }
  return `${from}${to}`;
}
