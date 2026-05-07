import { memo, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import type { Square } from 'chess.js';
import { MemoChessboard } from '../MemoChessboard';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { useBoardTheme } from '../../hooks/useBoardTheme';
// KS-2318: pointer-based drag (как в PuzzleBoard) — для drill shape='move'.
import { useFastDrag } from '../../hooks/useFastDrag';
// KS-2457: типы из explanation-engine'а — DrillBoard понимает role-based
// highlights (DrillExplanationHighlight) и стрелки (DrillBoardArrow).
import type { DrillExplanationHighlight, SquareRole } from './explanation/types';

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
/**
 * KS-2457: контракт стрелки DrillBoard'а. `react-chessboard@5`
 * требует `Arrow = { startSquare, endSquare, color: string }`. Цвета
 * на этом этапе — placeholder (KS-2458 layout заменит на токены).
 */
export interface DrillBoardArrow {
  startSquare: string;
  endSquare: string;
  color: string;
}

export interface DrillBoardProps {
  /** FEN позиции. */
  position: string;
  /** Сторона снизу. */
  boardOrientation?: 'white' | 'black';
  /** Клетки для жёлтой «внимание»-подсветки (целевые/важные). */
  highlightedSquares?: string[];
  /**
   * KS-2457: role-based подсветка клеток (приоритет
   * `wrong > missed > correct > target > context` при коллизии).
   * Применяется параллельно с `highlightedSquares` — последний даёт
   * базовый жёлтый, role-based перезаписывает по доминирующей роли.
   */
  roleHighlights?: DrillExplanationHighlight[];
  /**
   * KS-2457: стрелки на доске. Прокидываются в `MemoChessboard.options.arrows`.
   * `MemoChessboard` уже сравнивает `prevOpts.arrows` по identity — host
   * должен мемоизировать массив, чтобы не триггерить лишние ререндеры.
   */
  arrows?: DrillBoardArrow[];
  /** Произвольный overlay поверх доски (feedback, текстовая подсказка). */
  overlay?: ReactNode;
  /** Клик по клетке. Если не задан — клик игнорируется. */
  onSquareClick?: (square: Square) => void;
  /**
   * KS-2318: drag-and-drop ход (для drill shape='move'). Если задан —
   * pointer-drag на доске вызывает handler с from/to. `allowDragging`
   * автоматически включается для UI-фидбека (cursor: grab). Click-click
   * через `onSquareClick` остаётся доступен параллельно.
   *
   * Возвращаемое значение boolean игнорируется DrillBoard'ом — host
   * сам решает что делать с дропом.
   */
  onPieceDrop?: (args: { sourceSquare: string; targetSquare: string | null }) => boolean;
  /**
   * KS-2426: callback при pickup'е фигуры (drag прошёл threshold). Host
   * использует для звука 'select' / визуальной индикации. Срабатывает
   * только если задан `onPieceDrop`.
   */
  onPiecePickup?: (sourceSquare: string) => void;
  /**
   * Разрешить drag (по умолчанию false — drill в основном click/static).
   * Игнорируется если задан `onPieceDrop` — там drag реализован через
   * useFastDrag, а не через built-in react-chessboard drag.
   */
  allowDragging?: boolean;
}

const HIGHLIGHT_STYLE: CSSProperties = {
  backgroundColor: 'rgba(255, 230, 0, 0.45)',
};

/**
 * KS-2457: placeholder-стили role-based подсветки. Финальные цвета и
 * shadow'ы — KS-2458 layout (токенизация под темы). Здесь — рабочая
 * заглушка, чтобы UI читался уже сейчас.
 */
const ROLE_STYLE: Record<SquareRole, CSSProperties> = {
  target: { backgroundColor: 'rgba(255, 230, 0, 0.45)' },
  correct: { backgroundColor: 'rgba(34, 197, 94, 0.40)' },
  missed: { backgroundColor: 'rgba(148, 163, 184, 0.45)' },
  wrong: { backgroundColor: 'rgba(220, 38, 38, 0.40)' },
  context: { backgroundColor: 'rgba(59, 130, 246, 0.25)' },
};

/**
 * Приоритет ролей при коллизии: одна клетка может попасть в несколько
 * highlight'ов (KS-2454: например `target` + `correct` для loose-piece).
 * Решаем по доминирующей роли в порядке `wrong > missed > correct >
 * target > context` (см. ADR-043 §4.3).
 */
const ROLE_PRIORITY: Record<SquareRole, number> = {
  wrong: 5,
  missed: 4,
  correct: 3,
  target: 2,
  context: 1,
};

/**
 * KS-2428: компонент обёрнут в `React.memo`. До правки родительский
 * sprint-таймер ререндерил sprint-страницу 4 раза в секунду —
 * DrillBoard пересоздавал useMemo для options (хоть MemoChessboard
 * внутри и фильтровал тяжёлый ререндер Chessboard, useContainerWidth
 * + useFastDrag всё равно срабатывали). Memo на верхнем DrillBoard +
 * вынесенный SprintTimer убирают эти лишние циклы.
 *
 * memo использует дефолтное shallow-сравнение пропсов: если родитель
 * стабилизирует callback'и (через `useCallback` с правильными deps
 * или ref-based latest pattern) — компонент не ререндерится между
 * тиками таймера / сменой `pickedFrom` без смены drill'а.
 */
function DrillBoardImpl({
  position,
  boardOrientation = 'white',
  highlightedSquares,
  roleHighlights,
  arrows,
  overlay,
  onSquareClick,
  onPieceDrop,
  onPiecePickup,
  allowDragging = false,
}: DrillBoardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);
  const { boardThemeOptions, customPieces } = useBoardTheme();

  // KS-2318: pointer-based drag через container. Включается при
  // переданном onPieceDrop. Хук no-op'ом завершается если enabled=false.
  // KS-2405: drag разрешён только фигурами стороны-снизу-доски (=
  // side-to-move в drill-сценариях, см. DrillRunner.boardOrientation).
  // Раньше стояло allowBothColors:true и попытка взять чужую фигуру
  // приводила к feedback «неверно», портила статистику. Теперь useFastDrag
  // сам блокирует drag фигур не своего цвета, никакого ответа в submit
  // не уходит.
  useFastDrag(containerRef, {
    onPieceDrop:
      onPieceDrop ??
      (() => false /* unused, hook требует функцию даже при enabled=false */),
    onPiecePickup,
    boardOrientation,
    enabled: !!onPieceDrop,
    allowBothColors: false,
  });

  const squareStyles = useMemo<Record<string, CSSProperties> | undefined>(() => {
    const hasFlat = highlightedSquares && highlightedSquares.length > 0;
    const hasRole = roleHighlights && roleHighlights.length > 0;
    if (!hasFlat && !hasRole) return undefined;
    const styles: Record<string, CSSProperties> = {};
    if (hasFlat) {
      for (const sq of highlightedSquares!) styles[sq] = HIGHLIGHT_STYLE;
    }
    // KS-2457: role-based подсветка. Для каждой клетки выбираем
    // доминирующую роль по `ROLE_PRIORITY` и применяем её стиль (поверх
    // плоского highlight'а, если он был).
    if (hasRole) {
      const dominant: Record<string, SquareRole> = {};
      for (const h of roleHighlights!) {
        const prev = dominant[h.square];
        if (!prev || ROLE_PRIORITY[h.role] > ROLE_PRIORITY[prev]) {
          dominant[h.square] = h.role;
        }
      }
      for (const [sq, role] of Object.entries(dominant)) {
        styles[sq] = ROLE_STYLE[role];
      }
    }
    return styles;
  }, [highlightedSquares, roleHighlights]);

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
      ...(arrows && arrows.length > 0 && { arrows }),
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
      arrows,
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

export const DrillBoard = memo(DrillBoardImpl);
