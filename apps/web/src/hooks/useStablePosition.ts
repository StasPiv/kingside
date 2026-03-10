import { useRef, useMemo } from 'react';

/**
 * Piece data matching react-chessboard's PositionDataType value shape.
 */
type PieceData = { pieceType: string };

/**
 * Map of square -> piece data used by react-chessboard.
 * e.g. { a1: { pieceType: 'wR' }, b1: { pieceType: 'wN' }, ... }
 */
export type PositionObject = Record<string, PieceData>;

const FILES = 'abcdefgh';

/**
 * Extract only piece placement from a FEN string, returning a
 * position object keyed by square name matching react-chessboard's
 * PositionDataType format.
 *
 * Ignores side-to-move, castling, en-passant, half-move and full-move
 * counters — those don't affect visual piece positions.
 */
export function fenToPositionObject(fen: string): PositionObject {
  const placement = fen.split(' ')[0];
  const pos: PositionObject = {};
  const rows = placement.split('/');

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const rank = 8 - rowIdx; // FEN starts from rank 8
    let fileIdx = 0;
    for (const ch of rows[rowIdx]) {
      if (ch >= '1' && ch <= '8') {
        fileIdx += Number(ch);
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        const piece = ch.toUpperCase();
        const square = FILES[fileIdx] + rank;
        pos[square] = { pieceType: color + piece };
        fileIdx++;
      }
    }
  }

  return pos;
}

/**
 * Compare two position objects for shallow equality of piece placement.
 */
function positionsEqual(a: PositionObject, b: PositionObject): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key]?.pieceType !== b[key]?.pieceType) return false;
  }
  return true;
}

/**
 * Hook that converts a FEN string to a position object and returns
 * a referentially stable object that only changes when actual piece
 * positions differ.
 *
 * This prevents unnecessary re-renders of the Chessboard component
 * when FEN metadata (clocks, en-passant, castling) changes but
 * pieces stay on the same squares.
 */
export function useStablePosition(fen: string): PositionObject {
  const prevRef = useRef<PositionObject>({});

  return useMemo(() => {
    const next = fenToPositionObject(fen);
    if (positionsEqual(prevRef.current, next)) {
      return prevRef.current;
    }
    prevRef.current = next;
    return next;
  }, [fen]);
}
