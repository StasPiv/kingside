import { memo } from 'react';
import { Chessboard } from 'react-chessboard';
import type { PositionObject } from '../hooks/useStablePosition';

type ChessboardProps = Parameters<typeof Chessboard>[0];
type Options = NonNullable<ChessboardProps['options']>;

interface MemoChessboardProps {
  options: Options;
}

/**
 * Compare two position values (FEN string or position object).
 * Position objects are compared key-by-key via pieceType; strings by identity.
 */
function positionsEqual(
  a: string | Record<string, unknown> | undefined,
  b: string | Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'string') return a === b;
  if (a == null || b == null) return a === b;

  const objA = a as PositionObject;
  const objB = b as PositionObject;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const valA = objA[key];
    const valB = objB[key];
    if (valA === valB) continue;
    if (valA == null || valB == null) return false;
    // Compare pieceType for PositionDataType objects
    if (typeof valA === 'object' && typeof valB === 'object') {
      if ((valA as { pieceType?: string }).pieceType !== (valB as { pieceType?: string }).pieceType) return false;
    } else if (valA !== valB) {
      return false;
    }
  }
  return true;
}

/**
 * Custom areEqual for memo: re-render only when board-relevant
 * options actually change. Performs deep comparison on position
 * to avoid re-renders when piece placement is identical.
 */
function areOptionsEqual(
  prev: MemoChessboardProps,
  next: MemoChessboardProps,
): boolean {
  const prevOpts = prev.options;
  const nextOpts = next.options;

  // Compare position deeply
  if (!positionsEqual(prevOpts.position as string | Record<string, unknown>, nextOpts.position as string | Record<string, unknown>)) {
    return false;
  }

  // Compare other visual-relevant options by identity
  if (prevOpts.boardOrientation !== nextOpts.boardOrientation) return false;
  if (prevOpts.animationDurationInMs !== nextOpts.animationDurationInMs) return false;
  if (prevOpts.boardStyle !== nextOpts.boardStyle) return false;
  if (prevOpts.squareStyles !== nextOpts.squareStyles) return false;
  if (prevOpts.allowDragging !== nextOpts.allowDragging) return false;
  if (prevOpts.arrows !== nextOpts.arrows) return false;
  if (prevOpts.showNotation !== nextOpts.showNotation) return false;
  if (prevOpts.darkSquareStyle !== nextOpts.darkSquareStyle) return false;
  if (prevOpts.lightSquareStyle !== nextOpts.lightSquareStyle) return false;
  if (prevOpts.pieces !== nextOpts.pieces) return false;
  if (prevOpts.onSquareClick !== nextOpts.onSquareClick) return false;
  if (prevOpts.onPieceClick !== nextOpts.onPieceClick) return false;
  // KS-2152: правый клик и mousedown — выделение клеток в Мастерской.
  if (prevOpts.onSquareRightClick !== nextOpts.onSquareRightClick) return false;
  if (prevOpts.onSquareMouseDown !== nextOpts.onSquareMouseDown) return false;
  // KS-2152: drag-стрелки (onArrowsChange) — handleArrowsChange меняется
  // при обновлении currentAnnotations.
  if (prevOpts.onArrowsChange !== nextOpts.onArrowsChange) return false;

  return true;
}

/**
 * Memoized Chessboard that skips re-render when piece positions
 * and visual options haven't changed. This prevents full board
 * re-draws on moves where most squares remain unchanged.
 */
export const MemoChessboard = memo(function MemoChessboardInner(props: MemoChessboardProps) {
  return <Chessboard options={props.options} />;
}, areOptionsEqual);
