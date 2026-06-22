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
  /**
   * KS-4533. Готова ли доска принимать ввод пользователя. Внешние
   * клиенты (Playwright-сценарий записи видео, e2e) ждут
   * `[data-board-ready="true"]` перед drag-event'ом — иначе попадают
   * в окно между `boardKey++` (ремаунт `<MemoChessboard>`) и
   * применением setup-хода: новая позиция уже в DOM, но `game.turn()`
   * ещё не финален, fast-drag отказывает.
   *
   * Семантика:
   *   - `true` (по умолчанию) — обычные кадры: статичная задача,
   *     ход пользователя или ответ оппонента уже применён.
   *   - `false` — переходный момент в PuzzleRushPage между задачами:
   *     ремаунт доски прошёл, setup-ход ещё не применён.
   *
   * Атрибут отрисовывается ВСЕГДА (`true`/`false`), чтобы внешние
   * ждущие селекторы по `[data-board-ready=true]` работали единообразно
   * на всех страницах с `<PuzzleBoard>`.
   */
  ready?: boolean;
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
  ready = true,
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
      // KS-3366: 150 → 300ms. На 150ms ход соперника проскальзывал
      // незаметно (особенно blunderMove на старте precision-пазла —
      // KS-3365); 300ms даёт «вижу что фигура передвинулась», но всё
      // ещё ощущается отзывчиво при перетаскивании. Применяется ко всем
      // ходам (user + engine reply + opening setup-move).
      animationDurationInMs: (suppressAnimationRef.current || suppressAnimation) ? 0 : 300,
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

  // KS-3379: индикатор «чьего хода» в правом верхнем углу доски.
  // До этой задачи цвет был привязан к `boardOrientation` — но
  // ориентация доски ≠ side-to-move. В preventive saveEquality solver
  // играет за чёрных, доска перевёрнута (orientation='black') и ход
  // действительно чёрных — кружок чёрный, корректно. Но если solver
  // только что сходил и сейчас движок (или статичная позиция
  // pre-move) показывает ход НЕ orientation'а, индикатор оставался
  // в старом цвете. Привязка к `chess.turn()` исправляет это.
  // Fallback на orientation сохранён для случая `game === null`
  // (loading / лоадер).
  const turnColor: 'white' | 'black' = game
    ? game.turn() === 'w'
      ? 'white'
      : 'black'
    : boardOrientation;

  return (
    <div
      className="board-container"
      ref={boardContainerRef}
      data-board-ready={ready ? 'true' : 'false'}
      data-testid="puzzle-board"
    >
      <div
        className={`puzzle-turn-indicator puzzle-turn-indicator--${turnColor}`}
        data-testid="puzzle-turn-indicator"
        data-turn={turnColor}
      >
        {turnColor === 'white'
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
