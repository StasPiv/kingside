import { useState, useCallback, useMemo, useRef } from 'react';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';

// Colors for last-move highlight
// KS-3695: экспортируем константу — AnalysisPage сравнивает по ней
// background-color, чтобы отличить last-move-стиль от selected/legal
// и убрать его, когда поверх показан AI overlay.
export const LAST_MOVE_COLOR = 'rgba(255, 213, 0, 0.45)';

// Colors for legal move highlights
const MOVE_DOT_COLOR = 'rgba(0, 0, 0, 0.22)';
const CAPTURE_COLOR = 'rgba(220, 38, 38, 0.38)';
const CASTLING_COLOR = 'rgba(99, 102, 241, 0.45)';
const EN_PASSANT_COLOR = 'rgba(234, 88, 12, 0.45)';

// Selected square highlight
const SELECTED_COLOR = 'rgba(255, 213, 0, 0.55)';

// Semi-transparent arrow shown on hover over archive-tree suggested moves
const SUGGESTED_ARROW_COLOR = 'rgba(56, 189, 248, 0.55)';

interface ArrowData {
  startSquare: string;
  endSquare: string;
  color: string;
}

interface UseBoardHighlightsOptions {
  /** Current chess.js instance with the active position (may be null while loading) */
  game: Chess | null;
  /** Color of the player who can interact (for filtering moves) */
  playerColor?: 'white' | 'black' | null;
  /** Whether interaction is enabled (e.g. game is active) */
  enabled?: boolean;
  /**
   * If provided, enables two-click move mode: when a piece is selected and the
   * user clicks a legal destination square, this callback is invoked.
   * Intended for touch/mobile devices as an alternative to drag-and-drop.
   */
  onMove?: (from: Square, to: Square) => boolean;
}

interface UseBoardHighlightsResult {
  /** squareStyles to pass to MemoChessboard boardOptions */
  squareStyles: Record<string, React.CSSProperties>;
  /** arrows to pass to MemoChessboard boardOptions */
  arrows: ArrowData[];
  /**
   * KS-3695: квадраты последнего сделанного хода, отдельно от
   * `squareStyles`. AnalysisPage использует их, чтобы убрать last-move
   * подсветку, когда поверх показан AI overlay (selected/legal клики
   * пользователя при этом остаются).
   */
  lastMoveSquares: { from: Square; to: Square } | null;
  /** Call when a square/piece is clicked */
  onSquareClick: (square: Square) => void;
  /** Call after a move is made to record the last move */
  setLastMove: (from: Square, to: Square) => void;
  /** Clear last move highlight */
  clearLastMove: () => void;
  /** Clear selected square (e.g. after a drag drop) */
  clearSelection: () => void;
  /**
   * Show/hide a semi-transparent suggestion arrow (e.g. for hover over
   * archive-tree variation rows). Pass nulls to clear.
   */
  setSuggestedArrow: (from: Square | null, to: Square | null) => void;
}

export function useBoardHighlights({
  game,
  playerColor,
  enabled = true,
  onMove,
}: UseBoardHighlightsOptions): UseBoardHighlightsResult {
  const [selectedSquare, setSelectedSquareState] = useState<Square | null>(null);
  const [lastMove, setLastMoveState] = useState<{ from: Square; to: Square } | null>(null);
  const [suggestedArrow, setSuggestedArrowState] = useState<{ from: Square; to: Square } | null>(null);
  // Synchronous mirror of selectedSquare. React state updates are async, so when
  // react-chessboard fires onSquareClick AND onPieceClick for a single click on
  // a piece, both handlers run before the state re-render — without a sync ref
  // the second handler still sees the "old" selectedSquare and triggers the
  // move a second time, producing a duplicate entry in the move list (KS-1566).
  const selectedSquareRef = useRef<Square | null>(null);

  const setSelectedSquare = useCallback((value: Square | null) => {
    selectedSquareRef.current = value;
    setSelectedSquareState(value);
  }, []);

  const setLastMove = useCallback((from: Square, to: Square) => {
    setLastMoveState({ from, to });
    setSelectedSquare(null);
  }, [setSelectedSquare]);

  const clearLastMove = useCallback(() => {
    setLastMoveState(null);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedSquare(null);
  }, [setSelectedSquare]);

  const setSuggestedArrow = useCallback(
    (from: Square | null, to: Square | null) => {
      if (from && to && from !== to) {
        setSuggestedArrowState({ from, to });
      } else {
        setSuggestedArrowState(null);
      }
    },
    [],
  );

  const onSquareClick = useCallback(
    (square: Square) => {
      if (!enabled || !game) return;

      const currentSelected = selectedSquareRef.current;

      // Two-click move mode: if a piece is selected and user clicks a legal target
      if (onMove && currentSelected && currentSelected !== square) {
        const legalMoves = game.moves({ square: currentSelected, verbose: true });
        const isLegalTarget = legalMoves.some((m) => m.to === square);

        if (isLegalTarget) {
          // Clear selection BEFORE dispatching onMove so any follow-up
          // synchronous onSquareClick/onPieceClick for the same target square
          // cannot re-enter this branch and dispatch a duplicate move.
          setSelectedSquare(null);
          const moved = onMove(currentSelected, square);
          if (moved) {
            // setLastMove / clearSelection will be called by the move handler
            return;
          }
          // Move was rejected — fall through to normal click handling
        }
      }

      const piece = game.get(square);

      // If clicking on own piece — select it (or switch selection)
      if (piece) {
        const pieceColor = piece.color === 'w' ? 'white' : 'black';
        if (!playerColor || pieceColor === playerColor) {
          setSelectedSquare(square);
          return;
        }
      }

      // If clicking elsewhere — deselect
      setSelectedSquare(null);
    },
    [enabled, game, playerColor, onMove, setSelectedSquare],
  );

  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};

    // Last move highlight
    if (lastMove) {
      styles[lastMove.from] = { backgroundColor: LAST_MOVE_COLOR };
      styles[lastMove.to] = { backgroundColor: LAST_MOVE_COLOR };
    }

    // Selected square + legal moves
    if (selectedSquare && enabled && game) {
      styles[selectedSquare] = {
        ...styles[selectedSquare],
        backgroundColor: SELECTED_COLOR,
      };

      const moves = game.moves({ square: selectedSquare, verbose: true });
      for (const move of moves) {
        const target = move.to;
        const isCapture = !!move.captured;
        const isEnPassant = move.flags.includes('e');
        const isCastling = move.flags.includes('k') || move.flags.includes('q');

        if (isEnPassant) {
          styles[target] = { backgroundColor: EN_PASSANT_COLOR };
        } else if (isCastling) {
          styles[target] = { backgroundColor: CASTLING_COLOR };
        } else if (isCapture) {
          styles[target] = { backgroundColor: CAPTURE_COLOR };
        } else {
          // Regular move — dot overlay
          styles[target] = {
            background: `radial-gradient(circle, ${MOVE_DOT_COLOR} 28%, transparent 28%)`,
          };
        }
      }
    }

    return styles;
  }, [selectedSquare, lastMove, game, enabled]);

  const arrows = useMemo<ArrowData[]>(() => {
    if (!suggestedArrow) return [];
    return [
      {
        startSquare: suggestedArrow.from,
        endSquare: suggestedArrow.to,
        color: SUGGESTED_ARROW_COLOR,
      },
    ];
  }, [suggestedArrow]);

  return {
    squareStyles,
    arrows,
    // KS-3695: исходные квадраты last-move для AnalysisPage (фильтр
    // под AI overlay). null — last-move ещё не задан.
    lastMoveSquares: lastMove,
    onSquareClick,
    setLastMove,
    clearLastMove,
    clearSelection,
    setSuggestedArrow,
  };
}
