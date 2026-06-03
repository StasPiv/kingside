/**
 * KS-3632/KS-3633 / ADR-104 §4-5. Pure-логика Maia-3 (FEN→tensor +
 * legal-mask + декодер ходов). Скопирована один-в-один из
 * `apps/web/src/lib/maia/tensor.ts` (KS-3577) — единственное отличие
 * это `.js`-суффиксы в импортах под NodeNext-резолвер монорепо. Сам
 * шахматный/математический код идентичный; никаких браузерных API
 * не использует.
 *
 * Apps/web/src/lib/maia/tensor.ts пока живёт со своей копией — отдельной
 * задачей frontend может переключить его на `@kingside/maia-core`
 * (не блокер MVP-2 Precision-Maia).
 *
 * Maia-3 input layout (см. оригинальный CSSLab worker, MIT):
 *  - `tokens`     : (batch, 64, 12) float32, перспектива всегда white
 *                   (если в FEN ход чёрных — зеркалим FEN);
 *  - `elo_self`   : (batch,) float, continuous interpolation;
 *  - `elo_oppo`   : (batch,) float;
 *  - `legalMoves` : (batch, 4352) маска легальных ходов (не идёт в
 *                   модель — нужен для пост-обработки логитов).
 */
import { Chess, type Move } from 'chess.js';

import allPossibleMovesMaia3Dict from './data/all_moves_maia3.json';
import allPossibleMovesMaia3ReversedDict from './data/all_moves_maia3_reversed.json';

export const allPossibleMovesMaia3 = allPossibleMovesMaia3Dict as Record<
  string,
  number
>;
export const allPossibleMovesMaia3Reversed =
  allPossibleMovesMaia3ReversedDict as Record<string, string>;

/** Размер пространства ходов Maia-3 (берём из словаря, фактическое
 *  значение 4352, но не хардкодим). */
export const MAIA3_MOVE_VOCAB_SIZE = Object.keys(allPossibleMovesMaia3).length;

/**
 * Кодирует FEN в тензор (64, 12) float32 — по одной плоскости на
 * каждый тип фигуры. Доска всегда от лица белых (если в FEN ходят
 * чёрные — мы зеркалим FEN перед вызовом этой функции, см.
 * `preprocessMaia3`).
 */
function boardToMaia3Tokens(fen: string): Float32Array {
  const tokens = fen.split(' ');
  const piecePlacement = tokens[0];

  // Порядок фигур: белые P,N,B,R,Q,K (0-5), чёрные p,n,b,r,q,k (6-11).
  const pieceTypes = [
    'P',
    'N',
    'B',
    'R',
    'Q',
    'K',
    'p',
    'n',
    'b',
    'r',
    'q',
    'k',
  ];
  const tensor = new Float32Array(64 * 12);

  const rows = piecePlacement.split('/');

  for (let rank = 0; rank < 8; rank++) {
    const row = 7 - rank;
    let file = 0;
    for (const char of rows[rank]) {
      if (Number.isNaN(parseInt(char, 10))) {
        const pieceIdx = pieceTypes.indexOf(char);
        if (pieceIdx >= 0) {
          const square = row * 8 + file;
          tensor[square * 12 + pieceIdx] = 1.0;
        }
        file += 1;
      } else {
        file += parseInt(char, 10);
      }
    }
  }

  return tensor;
}

function mirrorSquare(square: string): string {
  const fileChar = square.charAt(0);
  const rank = (9 - parseInt(square.charAt(1), 10)).toString();
  return fileChar + rank;
}

export function mirrorMove(moveUci: string): string {
  const isPromotion = moveUci.length > 4;
  const startSquare = moveUci.substring(0, 2);
  const endSquare = moveUci.substring(2, 4);
  const promotionPiece = isPromotion ? moveUci.substring(4) : '';

  return mirrorSquare(startSquare) + mirrorSquare(endSquare) + promotionPiece;
}

function swapColorsInRank(rank: string): string {
  let swappedRank = '';
  for (const char of rank) {
    if (/[A-Z]/.test(char)) {
      swappedRank += char.toLowerCase();
    } else if (/[a-z]/.test(char)) {
      swappedRank += char.toUpperCase();
    } else {
      swappedRank += char;
    }
  }
  return swappedRank;
}

function swapCastlingRights(castling: string): string {
  if (castling === '-') return '-';

  const rights = new Set(castling.split(''));
  const swapped = new Set<string>();

  if (rights.has('K')) swapped.add('k');
  if (rights.has('Q')) swapped.add('q');
  if (rights.has('k')) swapped.add('K');
  if (rights.has('q')) swapped.add('Q');

  let output = '';
  if (swapped.has('K')) output += 'K';
  if (swapped.has('Q')) output += 'Q';
  if (swapped.has('k')) output += 'k';
  if (swapped.has('q')) output += 'q';

  return output === '' ? '-' : output;
}

/**
 * Зеркалит FEN вертикально (top↔bottom) со сменой цветов фигур,
 * активного цвета, прав на рокировку и en passant. Используется
 * чтобы привести позицию к «ходу белых» — Maia-3 всегда смотрит на
 * доску со стороны ходящего.
 */
function mirrorFEN(fen: string): string {
  const [position, activeColor, castling, enPassant, halfmove, fullmove] =
    fen.split(' ');

  const ranks = position.split('/');
  const mirroredRanks = ranks
    .slice()
    .reverse()
    .map((rank) => swapColorsInRank(rank));
  const mirroredPosition = mirroredRanks.join('/');

  const mirroredActiveColor = activeColor === 'w' ? 'b' : 'w';
  const mirroredCastling = swapCastlingRights(castling);
  const mirroredEnPassant = enPassant !== '-' ? mirrorSquare(enPassant) : '-';

  return `${mirroredPosition} ${mirroredActiveColor} ${mirroredCastling} ${mirroredEnPassant} ${halfmove} ${fullmove}`;
}

export interface Maia3Preprocessed {
  /** (64, 12) float32, perspective of side-to-move (всегда «белые»). */
  boardTokens: Float32Array;
  /** (MAIA3_MOVE_VOCAB_SIZE,) маска: 1.0 для легального хода, 0.0 для
   *  нелегального. Применяется к логитам в post-processing. */
  legalMoves: Float32Array;
  /** Был ли FEN зеркален (нужно знать чтобы зеркально декодировать
   *  ходы обратно). */
  blackToMove: boolean;
}

/** Препроцессинг FEN под Maia-3: tokens + legal mask + флаг зеркала. */
export function preprocessMaia3(fen: string): Maia3Preprocessed {
  const sideToMove = fen.split(' ')[1];
  if (sideToMove !== 'w' && sideToMove !== 'b') {
    throw new Error(`Invalid FEN (no side to move): ${fen}`);
  }

  const blackToMove = sideToMove === 'b';
  let board = new Chess(fen);
  if (blackToMove) {
    board = new Chess(mirrorFEN(board.fen()));
  }

  const boardTokens = boardToMaia3Tokens(board.fen());

  const legalMoves = new Float32Array(MAIA3_MOVE_VOCAB_SIZE);
  for (const move of board.moves({ verbose: true }) as Move[]) {
    const promotion = move.promotion ? move.promotion : '';
    const moveIndex = allPossibleMovesMaia3[move.from + move.to + promotion];
    if (moveIndex !== undefined) {
      legalMoves[moveIndex] = 1.0;
    }
  }

  return { boardTokens, legalMoves, blackToMove };
}
