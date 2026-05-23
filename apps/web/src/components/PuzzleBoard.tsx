import { useRef, useMemo, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Square } from 'chess.js';
import type { Chess } from 'chess.js';
import { MemoChessboard } from './MemoChessboard';
import { useContainerWidth } from '../hooks/useContainerWidth';
import { useFastDrag } from '../hooks/useFastDrag';
import { useStablePosition } from '../hooks/useStablePosition';
import { useBoardTheme } from '../hooks/useBoardTheme';
import { useBoardHighlights } from '../hooks/useBoardHighlights';

interface PuzzleBoardArrow {
  startSquare: string;
  endSquare: string;
  color: string;
}

interface PuzzleBoardProps {
  game: Chess | null;
  boardOrientation: 'white' | 'black';
  enabled: boolean;
  onPieceDrop: (args: { sourceSquare: string; targetSquare: string | null }) => boolean;
  lastMoveUci?: string | null;
  suppressAnimation?: boolean;
  boardKey?: string | number;
  status?: 'thinking' | 'checking' | 'correct' | 'incorrect' | null;
  /**
   * KS-3274: дополнительные стрелки от вызывающего кода (hint в
   * opening-trainer). Сливаются с внутренними suggested-стрелками из
   * `useBoardHighlights` — добавляются в конец, чтобы рисовались поверх.
   */
  customArrows?: PuzzleBoardArrow[];
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
  customArrows,
  children,
}: PuzzleBoardProps) {
  const { t } = useTranslation();
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);
  const { boardThemeOptions, customPieces } = useBoardTheme();
  const onClickMove = useCallback(
    (from: Square, to: Square): boolean => onPieceDrop({ sourceSquare: from, targetSquare: to }),
    [onPieceDrop],
  );

  const { squareStyles, arrows: internalArrows, setLastMove, clearLastMove, onSquareClick } = useBoardHighlights({
    game: game ?? null,
    playerColor: boardOrientation,
    enabled,
    onMove: onClickMove,
  });

  // KS-3274: сливаем кастомные стрелки (hint в opening-trainer) с
  // внутренними suggested-стрелками. `useMemo` — чтобы не было ре-рендеров
  // MemoChessboard при неизменных входах.
  const arrows = useMemo(
    () =>
      customArrows && customArrows.length > 0
        ? [...internalArrows, ...customArrows]
        : internalArrows,
    [internalArrows, customArrows],
  );

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

  const handlePieceClick = useCallback(
    ({ square }: { isSparePiece?: boolean; piece?: unknown; square: string | null }) => {
      if (square) onSquareClick(square as Square);
    },
    [onSquareClick],
  );

  const { suppressAnimationRef } = useFastDrag(boardContainerRef, {
    onPieceDrop,
    boardOrientation,
    enabled,
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
      arrows,
      onSquareClick: handleSquareClick,
      onPieceClick: handlePieceClick,
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
      ...(customPieces && { pieces: customPieces }),
    }),
    [stablePosition, boardOrientation, boardStyle, boardThemeOptions, customPieces, squareStyles, arrows, handleSquareClick, handlePieceClick, suppressAnimation],
  );

  return (
    <div className="board-container" ref={boardContainerRef}>
      <div className={`puzzle-turn-indicator puzzle-turn-indicator--${boardOrientation}`}>
        {boardOrientation === 'white'
          ? t('puzzle.whiteToMove', 'White to move')
          : t('puzzle.blackToMove', 'Black to move')}
      </div>
      {status != null && (
        <div className={`puzzle-indicator puzzle-indicator--${status}`} />
      )}
      {game && <MemoChessboard key={boardKey} options={boardOptions} />}
      {children}
    </div>
  );
}
