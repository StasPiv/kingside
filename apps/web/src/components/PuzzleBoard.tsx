import { useRef, useMemo, useCallback, type ReactNode } from 'react';
import type { Square } from 'chess.js';
import type { Chess } from 'chess.js';
import { MemoChessboard } from './MemoChessboard';
import { useContainerWidth } from '../hooks/useContainerWidth';
import { useFastDrag } from '../hooks/useFastDrag';
import { useStablePosition } from '../hooks/useStablePosition';
import { useBoardTheme } from '../hooks/useBoardTheme';
import { useBoardSettings } from '../hooks/useBoardSettings';
import { useBoardHighlights } from '../hooks/useBoardHighlights';

interface PuzzleBoardProps {
  game: Chess | null;
  boardOrientation: 'white' | 'black';
  enabled: boolean;
  onPieceDrop: (args: { sourceSquare: string; targetSquare: string | null }) => boolean;
  lastMoveUci?: string | null;
  suppressAnimation?: boolean;
  boardKey?: string | number;
  status?: 'thinking' | 'correct' | 'incorrect' | null;
  children?: ReactNode;
}

export function PuzzleBoard({
  game,
  boardOrientation,
  enabled,
  onPieceDrop,
  lastMoveUci,
  suppressAnimation = false,
  boardKey,
  status,
  children,
}: PuzzleBoardProps) {
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);
  const { boardThemeOptions, customPieces } = useBoardTheme();
  const { inputMode } = useBoardSettings();

  const onClickMove = useCallback(
    (from: Square, to: Square): boolean => onPieceDrop({ sourceSquare: from, targetSquare: to }),
    [onPieceDrop],
  );

  const { squareStyles, setLastMove, clearLastMove, onSquareClick } = useBoardHighlights({
    game: game ?? null,
    playerColor: boardOrientation,
    enabled,
    onMove: inputMode === 'click' ? onClickMove : undefined,
  });

  // Sync last move highlight
  const lastMoveRef = useRef(lastMoveUci);
  if (lastMoveRef.current !== lastMoveUci) {
    lastMoveRef.current = lastMoveUci;
    if (lastMoveUci && lastMoveUci.length >= 4) {
      setLastMove(lastMoveUci.slice(0, 2) as Square, lastMoveUci.slice(2, 4) as Square);
    } else {
      clearLastMove();
    }
  }

  const handleSquareClick = useCallback(
    ({ square }: { piece: unknown; square: string }) => {
      onSquareClick(square as Square);
    },
    [onSquareClick],
  );

  const { suppressAnimationRef } = useFastDrag(boardContainerRef, {
    onPieceDrop,
    boardOrientation,
    enabled: enabled && inputMode === 'drag',
  });

  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const stablePosition = useStablePosition(game?.fen() ?? '');

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation,
      animationDurationInMs: (suppressAnimationRef.current || suppressAnimation) ? 0 : 150,
      allowDragging: false,
      showNotation: true,
      squareStyles,
      onSquareClick: handleSquareClick,
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
      ...(customPieces && { pieces: customPieces }),
    }),
    [stablePosition, boardOrientation, boardStyle, boardThemeOptions, customPieces, squareStyles, handleSquareClick, suppressAnimation],
  );

  return (
    <div className="board-container" ref={boardContainerRef}>
      {status != null && (
        <div className={`puzzle-indicator puzzle-indicator--${status}`} />
      )}
      {game && <MemoChessboard key={boardKey} options={boardOptions} />}
      {children}
    </div>
  );
}
