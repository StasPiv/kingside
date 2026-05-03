import { useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import type { Square } from 'chess.js';
import { MemoChessboard } from '../MemoChessboard';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { useBoardTheme } from '../../hooks/useBoardTheme';

/**
 * KS-2234 (ADR-035 §7.3, E3) — обёртка `Chessboard` для drill-сценариев.
 *
 * Drill — это статичная позиция, на которой пользователь отвечает на
 * вопрос (например, «сколько белых атакует e5?»). Доска в drill'е НЕ
 * управляет ходами, она только показывает позицию + опциональные
 * подсветки клеток (`highlightedSquares`) и произвольный overlay поверх
 * (`overlay`). Клик по клетке проксируется через `onSquareClick`, чтобы
 * хост-компонент мог обрабатывать input (например, drill-shape='click').
 *
 * # Контракт DOM
 *
 *   <div class="drill-board" data-testid="drill-board">
 *     <MemoChessboard … />
 *     {overlay}  // optional, абсолютно позиционируется поверх
 *   </div>
 *
 * # Подсветка клеток
 *
 * `highlightedSquares` — массив клеток в формате chess.js (`'e5'`).
 * Каждая клетка получает `backgroundColor: rgba(255, 230, 0, 0.45)` —
 * мягкий жёлтый, поверх стандартной подсветки темы. Цвет выбран как
 * нейтральный «внимание сюда» (отличается от green/red feedback).
 *
 * Для drill'ов с feedback overlay (correct/incorrect) используй
 * `<DrillFeedbackOverlay>` через prop `overlay`, не через
 * `highlightedSquares`.
 */
export interface DrillBoardProps {
  /** FEN позиции. */
  position: string;
  /** Сторона снизу. */
  boardOrientation?: 'white' | 'black';
  /** Клетки для жёлтой «внимание»-подсветки (целевые/важные). */
  highlightedSquares?: string[];
  /** Произвольный overlay поверх доски (feedback, текстовая подсказка). */
  overlay?: ReactNode;
  /** Клик по клетке. Если не задан — клик игнорируется. */
  onSquareClick?: (square: Square) => void;
  /**
   * Разрешить drag (по умолчанию false — drill в основном click/static).
   */
  allowDragging?: boolean;
}

const HIGHLIGHT_STYLE: CSSProperties = {
  backgroundColor: 'rgba(255, 230, 0, 0.45)',
};

export function DrillBoard({
  position,
  boardOrientation = 'white',
  highlightedSquares,
  overlay,
  onSquareClick,
  allowDragging = false,
}: DrillBoardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);
  const { boardThemeOptions, customPieces } = useBoardTheme();

  const squareStyles = useMemo<Record<string, CSSProperties> | undefined>(() => {
    if (!highlightedSquares || highlightedSquares.length === 0) return undefined;
    const styles: Record<string, CSSProperties> = {};
    for (const sq of highlightedSquares) styles[sq] = HIGHLIGHT_STYLE;
    return styles;
  }, [highlightedSquares]);

  const handleClick = useMemo(() => {
    if (!onSquareClick) return undefined;
    return ({ square }: { piece: unknown; square: string }) => {
      if (square) onSquareClick(square as Square);
    };
  }, [onSquareClick]);

  const boardStyle = useMemo<CSSProperties | undefined>(
    () => (width > 0 ? { width, height: width } : undefined),
    [width],
  );

  const options = useMemo(
    () => ({
      position,
      boardOrientation,
      animationDurationInMs: 0,
      allowDragging,
      showNotation: true,
      ...(squareStyles && { squareStyles }),
      ...(handleClick && { onSquareClick: handleClick }),
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
      ...(customPieces && { pieces: customPieces }),
    }),
    [
      position,
      boardOrientation,
      allowDragging,
      squareStyles,
      handleClick,
      boardStyle,
      boardThemeOptions,
      customPieces,
    ],
  );

  return (
    <div className="drill-board" data-testid="drill-board" ref={containerRef}>
      <MemoChessboard options={options} />
      {overlay && (
        <div className="drill-board__overlay" data-testid="drill-board-overlay">
          {overlay}
        </div>
      )}
    </div>
  );
}
