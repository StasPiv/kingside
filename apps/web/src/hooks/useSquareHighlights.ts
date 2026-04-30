import { useCallback, useMemo, useRef } from 'react';
import type { AnnotationColor, SquareHighlight } from '../review/types';

/**
 * KS-2152: цвета выделения клеток (lichess-style).
 */
export const HIGHLIGHT_COLORS: Record<AnnotationColor, string> = {
  red: 'rgba(235, 97, 80, 0.8)',
  green: 'rgba(82, 184, 72, 0.8)',
  blue: 'rgba(0, 121, 191, 0.8)',
  yellow: 'rgba(252, 220, 88, 0.85)',
};

interface MouseModifiers {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

function colorByModifiers(mods: MouseModifiers): AnnotationColor {
  // Shift → зелёный, Alt → синий, Ctrl/Cmd → жёлтый, без модификаторов → красный
  if (mods.shiftKey) return 'green';
  if (mods.altKey) return 'blue';
  if (mods.ctrlKey || mods.metaKey) return 'yellow';
  return 'red';
}

interface UseSquareHighlightsOptions {
  /**
   * Текущий набор выделений для отображаемой позиции (controlled).
   * Меняется снаружи при навигации между ходами — выделения берутся из
   * аннотаций соответствующего узла дерева.
   */
  value: SquareHighlight[] | undefined;
  /**
   * Колбэк, вызываемый при toggle выделения. Снаружи решается, что
   * сделать с новым набором (сохранить на ноду дерева, для стартовой
   * позиции — в initialAnnotations).
   */
  onChange: (next: SquareHighlight[]) => void;
}

interface UseSquareHighlightsResult {
  /** Стили клеток для слияния в общий squareStyles (передать в boardOptions). */
  highlightStyles: Record<string, React.CSSProperties>;
  /** Перехватчик mousedown — запоминает модификаторы клавиатуры для ПКМ. */
  handleSquareMouseDown: (
    args: { square: string },
    e: React.MouseEvent,
  ) => void;
  /** Toggle выделения клетки в onSquareRightClick. */
  handleSquareRightClick: (args: { square: string }) => void;
}

/**
 * Хук выделения клеток правым кликом (lichess-style), управляемая версия.
 *
 * - Правый клик по клетке → подсветить выбранным цветом.
 * - Повторный правый клик по той же клетке тем же цветом → снять выделение.
 * - Цвет: Shift = зелёный, Alt = синий, Ctrl/Cmd = жёлтый, без = красный.
 * - Состояние выделений приходит снаружи (`value`) и обновляется через
 *   `onChange`. Это позволяет привязать выделения к конкретной ноде
 *   дерева анализа (KS-2152): при навигации между ходами вызывающая
 *   сторона передаёт другой `value`, а изменения сохраняет на нужную ноду.
 *
 * @see KS-2152
 */
export function useSquareHighlights({
  value,
  onChange,
}: UseSquareHighlightsOptions): UseSquareHighlightsResult {
  const pendingModifiersRef = useRef<MouseModifiers | null>(null);

  // Замыкаем `value` через ref — нужен в onSquareRightClick, который
  // memoized один раз через useCallback с пустыми deps (стабильная ссылка
  // важна для MemoChessboard сравнения по identity).
  const valueRef = useRef<SquareHighlight[] | undefined>(value);
  valueRef.current = value;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handleSquareMouseDown = useCallback(
    (_args: { square: string }, e: React.MouseEvent) => {
      if (e.button === 2) {
        pendingModifiersRef.current = {
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
        };
      }
    },
    [],
  );

  const handleSquareRightClick = useCallback(({ square }: { square: string }) => {
    const mods = pendingModifiersRef.current ?? {
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    };
    pendingModifiersRef.current = null;
    const color = colorByModifiers(mods);

    const current = valueRef.current ?? [];
    const existingIdx = current.findIndex((h) => h.square === square);
    let next: SquareHighlight[];
    if (existingIdx >= 0 && current[existingIdx].color === color) {
      // тот же цвет — снимаем выделение
      next = current.slice(0, existingIdx).concat(current.slice(existingIdx + 1));
    } else if (existingIdx >= 0) {
      // другой цвет — заменяем
      next = current.slice();
      next[existingIdx] = { square, color };
    } else {
      next = current.concat({ square, color });
    }
    onChangeRef.current(next);
  }, []);

  const highlightStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (value) {
      for (const h of value) {
        styles[h.square] = { backgroundColor: HIGHLIGHT_COLORS[h.color] };
      }
    }
    return styles;
  }, [value]);

  return {
    highlightStyles,
    handleSquareMouseDown,
    handleSquareRightClick,
  };
}
