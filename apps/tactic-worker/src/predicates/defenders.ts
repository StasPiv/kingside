/**
 * KS-2339. Общий helper «есть ли защитник у клетки» с учётом
 * рентгеновской защиты (X-ray defenders).
 *
 * Жалоба пользователя в KS-2339: ход Rc7-c8 не должен считаться
 * «нападением на незащищённого ферзя b8», потому что ферзь рентгеном
 * защищён ладьёй d8 (после Rxb8 ладья на b8 будет атакована Rd8 через
 * освободившуюся c8).
 *
 * `chess.attackers(sq, color)` отдаёт только прямых атакующих —
 * sliding piece с заблокированной линией не учитывается. Здесь
 * добавляем геометрический проход по 8 направлениям: если на луче
 * sliding-piece-противника (Q/R по rank/file, Q/B по диагоналям)
 * до клетки `sq` стоит ровно одна блокирующая фигура (любая) — это
 * X-ray защитник. Достаточно одного защитника (прямого или X-ray)
 * чтобы клетка считалась защищённой.
 *
 * Используется в `find-loose-piece`, `find-hanging-piece` и
 * `find-undefended-attack` — все три предиката классифицируют цели
 * по «незащищённости» и страдали от той же ошибки.
 */

import type { Chess, Square as ChessJsSquare } from 'chess.js';

type DirType = 'rook' | 'bishop';

const DIRECTIONS: Array<[df: number, dr: number, kind: DirType]> = [
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

function isLineSlider(
  pieceType: string,
  dir: DirType,
): boolean {
  if (pieceType === 'q') return true;
  if (pieceType === 'r' && dir === 'rook') return true;
  if (pieceType === 'b' && dir === 'bishop') return true;
  return false;
}

/**
 * Возвращает true, если у клетки `sq` есть хотя бы один защитник
 * цвета `defenderColor`:
 *   - прямой (chess.attackers), либо
 *   - X-ray sliding piece (Q/R/B), чей луч до `sq` заблокирован ровно
 *     одной фигурой (любого цвета). После «удаления» этой блокирующей
 *     фигуры (т. е. в ходе размена) sliding piece становится прямым
 *     атакующим клетки.
 *
 * Не делает имитацию обмена и не зависит от атакующего — даёт
 * консервативный результат «защита есть» при любых X-ray линиях.
 */
export function hasDirectOrXRayDefender(
  chess: Chess,
  sq: ChessJsSquare,
  defenderColor: 'w' | 'b',
): boolean {
  if (chess.attackers(sq, defenderColor).length > 0) return true;

  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;

  for (const [df, dr, kind] of DIRECTIONS) {
    let f = file + df;
    let r = rank + dr;
    let blockerSeen = false;
    while (true) {
      const cell = squareAt(f, r);
      if (!cell) break;
      const piece = chess.get(cell);
      if (piece) {
        if (!blockerSeen) {
          // Первый встреченный кусок — потенциальный блокер. Идём дальше.
          blockerSeen = true;
        } else {
          // Второй piece по тому же лучу — кандидат в X-ray defender.
          if (
            piece.color === defenderColor &&
            isLineSlider(piece.type, kind)
          ) {
            return true;
          }
          // Любая фигура останавливает дальнейший обзор.
          break;
        }
      }
      f += df;
      r += dr;
    }
  }
  return false;
}
