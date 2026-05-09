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
 * Условие KS-2336/KS-2340 «существует pseudo-legal ход P не на прямой
 * связки» сняли: пользователи и шахматные тренажёры считают связкой и
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
 * Скейл ценности (см. `types.PIECE_VALUE`):
 *   pawn=1, knight=3, bishop=3, rook=5, queen=9, king=Inf.
 * При equal-value «связка» не считается (никакой выгоды от удержания
 * пина).
 *
 * Strict-uniqueness: ровно одна связанная фигура (любого вида), иначе
 * drop. Сторона на ходу не важна — показываем связки обоих цветов.
 */

import type { Square as ChessJsSquare } from 'chess.js';
import type { AnswerSquare } from '@kingside/shared';
import { Chess } from 'chess.js';
import {
  allPieces,
  oppColor,
  PIECE_VALUE,
  tryLoadChess,
  type SquareResult,
} from './types';

type PinDir = 'rook' | 'bishop';

const DIRECTIONS: Array<[df: number, dr: number, kind: PinDir]> = [
  [0, 1, 'rook'], [0, -1, 'rook'], [1, 0, 'rook'], [-1, 0, 'rook'],
  [1, 1, 'bishop'], [1, -1, 'bishop'], [-1, 1, 'bishop'], [-1, -1, 'bishop'],
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

interface PinAnchor {
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
function findPinAnchor(
  chess: Chess,
  pSq: ChessJsSquare,
  pColor: 'w' | 'b',
): PinAnchor | null {
  const enemy = oppColor(pColor);
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

    // KS-2615: классическое определение связки — наличие X-ray-атаки
    // через P достаточно. Условие «есть ход вне линии связки» снято
    // (см. шапку файла).
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
