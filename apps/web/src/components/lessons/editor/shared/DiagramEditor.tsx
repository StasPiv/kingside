import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import type {
  DiagramArrow,
  DiagramHighlight,
} from '@kingside/shared';

import {
  HIGHLIGHT_COLORS,
  annotationColorByModifiers,
} from '../../../../hooks/useSquareHighlights';
import type {
  AnnotationColor,
  ArrowAnnotation,
  SquareHighlight,
} from '../../../../review/types';

/**
 * KS-2571: shared визуальный редактор шахматной диаграммы.
 *
 * Используется в TextStepEditor, QuizStepEditor, PositionStepEditor,
 * GameReviewStepEditor (см. ADR-049, KS-2568). До этого тикета автор
 * курса должен был вписывать FEN/arrows/highlightedSquares JSON руками.
 *
 * Возможности:
 *  - drag фигур → меняем FEN (через прямое манипулирование board-dict,
 *    разрешая нелегальные позиции — это редактор, не движок).
 *  - правый клик клетка→клетка drag → toggle стрелки (arrow);
 *  - одиночный правый клик → toggle highlight;
 *  - модификаторы клавиш → цвет (см. annotationColorByModifiers): без
 *    модификаторов = красный, Shift = зелёный, Alt = синий, Ctrl/Cmd =
 *    жёлтый. Маппинг тот же, что в AnalysisPage / lichess.
 *  - кнопки «Очистить стрелки», «Очистить выделения», «Сбросить FEN».
 *  - caption-input и orientation-select под доской.
 *  - mobile mode-toggle (определение через `matchMedia('(pointer:coarse)')`):
 *    «Drag pieces» / «Draw arrows», т. к. RMB+modifier-keys на тач-экране
 *    не работают. На desktop (pointer:fine) drag и drawing активны
 *    одновременно (LMB → drag, RMB → drawing).
 *  - `drawingDisabled` — скрывает все drawing-инструменты (кнопки,
 *    mode-toggle), оставляет FEN-picker и orientation. Используется
 *    QuizStepEditor для опц. `fen`.
 *
 * Drawing-логика — общий `annotationColorByModifiers` из
 * `useSquareHighlights`. Состояние стрелок/highlights хранится в форме
 * `DiagramArrow`/`DiagramHighlight` (CSS-цвет), а внутри редактора
 * конвертируется в каноническую `AnnotationColor` через `HIGHLIGHT_COLORS`
 * для совпадения цветов с AnalysisPage.
 */

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const PIECE_TO_FEN: Record<string, string> = {
  wK: 'K', wQ: 'Q', wR: 'R', wB: 'B', wN: 'N', wP: 'P',
  bK: 'k', bQ: 'q', bR: 'r', bB: 'b', bN: 'n', bP: 'p',
};

const FEN_TO_PIECE: Record<string, string> = {
  K: 'wK', Q: 'wQ', R: 'wR', B: 'wB', N: 'wN', P: 'wP',
  k: 'bK', q: 'bQ', r: 'bR', b: 'bB', n: 'bN', p: 'bP',
};

const FILES = 'abcdefgh';

function fenToBoard(fen: string): {
  board: Record<string, string>;
  turn: 'w' | 'b';
  castling: string;
  ep: string;
  half: string;
  full: string;
} {
  const parts = fen.split(' ');
  const board: Record<string, string> = {};
  const rows = (parts[0] ?? '').split('/');
  for (let ri = 0; ri < rows.length; ri++) {
    const rank = 8 - ri;
    let file = 0;
    for (const ch of rows[ri]) {
      if (ch >= '1' && ch <= '8') {
        file += parseInt(ch, 10);
      } else {
        const sq = `${FILES[file]}${rank}`;
        if (FEN_TO_PIECE[ch]) board[sq] = FEN_TO_PIECE[ch];
        file++;
      }
    }
  }
  return {
    board,
    turn: parts[1] === 'b' ? 'b' : 'w',
    castling: parts[2] || '-',
    ep: parts[3] || '-',
    half: parts[4] || '0',
    full: parts[5] || '1',
  };
}

function boardToFen(
  board: Record<string, string>,
  turn: 'w' | 'b',
  castling: string,
  ep: string,
  half: string,
  full: string,
): string {
  const rows: string[] = [];
  for (let r = 8; r >= 1; r--) {
    let row = '';
    let empty = 0;
    for (const f of FILES) {
      const sq = `${f}${r}`;
      const p = board[sq];
      if (p) {
        if (empty > 0) {
          row += empty;
          empty = 0;
        }
        row += PIECE_TO_FEN[p] || '?';
      } else {
        empty++;
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${turn} ${castling || '-'} ${ep || '-'} ${half} ${full}`;
}

/**
 * Reverse-lookup CSS-цвета (как сохраняем в DiagramArrow.color) →
 * каноническая AnnotationColor. Если цвет не из палитры — fallback на
 * red (так аннотация останется хоть какого-то цвета, не пустого).
 */
function cssColorToAnnotationColor(css: string | undefined): AnnotationColor {
  if (!css) return 'red';
  for (const key of Object.keys(HIGHLIGHT_COLORS) as AnnotationColor[]) {
    if (HIGHLIGHT_COLORS[key] === css) return key;
  }
  return 'red';
}

function arrowToInternal(a: DiagramArrow): ArrowAnnotation {
  return {
    from: a.from,
    to: a.to,
    color: cssColorToAnnotationColor(a.color),
  };
}

function highlightToInternal(h: DiagramHighlight): SquareHighlight {
  return {
    square: h.square,
    color: cssColorToAnnotationColor(h.color),
  };
}

function arrowToExternal(a: ArrowAnnotation): DiagramArrow {
  return { from: a.from, to: a.to, color: HIGHLIGHT_COLORS[a.color] };
}

function highlightToExternal(h: SquareHighlight): DiagramHighlight {
  return { square: h.square, color: HIGHLIGHT_COLORS[h.color] };
}

export interface DiagramEditorProps {
  fen: string;
  caption?: string;
  orientation?: 'white' | 'black';
  arrows?: DiagramArrow[];
  highlightedSquares?: DiagramHighlight[];
  onChange: (next: {
    fen: string;
    caption?: string;
    orientation?: 'white' | 'black';
    arrows: DiagramArrow[];
    highlightedSquares: DiagramHighlight[];
  }) => void;
  /** Скрыть инструменты рисования (для FEN-picker'а в quiz). */
  drawingDisabled?: boolean;
}

/**
 * Detect coarse pointer (touch). Безопасный wrapper: в SSR/тестах без
 * matchMedia вернёт false.
 */
function detectCoarsePointer(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(pointer:coarse)').matches;
  } catch {
    return false;
  }
}

export function DiagramEditor({
  fen,
  caption,
  orientation,
  arrows,
  highlightedSquares,
  onChange,
  drawingDisabled = false,
}: DiagramEditorProps) {
  const { t } = useTranslation();

  // Pointer mode (mobile vs desktop). Считаем 1 раз при монтировании;
  // matchMedia change-listener смысла не имеет в реальной задаче (тип
  // указателя обычно не меняется), но в тестах позволяем мок переопределить
  // через initial render.
  const [isCoarse, setIsCoarse] = useState<boolean>(detectCoarsePointer);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    let mql: MediaQueryList | null = null;
    try {
      mql = window.matchMedia('(pointer:coarse)');
    } catch {
      return;
    }
    if (!mql) return;
    const handler = () => setIsCoarse(mql!.matches);
    if (mql.addEventListener) mql.addEventListener('change', handler);
    return () => {
      if (mql && mql.removeEventListener) mql.removeEventListener('change', handler);
    };
  }, []);

  const [mode, setMode] = useState<'drag' | 'draw'>('drag');
  // Reset mode → 'drag' when drawing полностью отключён (например,
  // прокидывается drawingDisabled в QuizStep'е). Не критично для
  // рендера, но не оставляем «зависшее» 'draw'-состояние.
  useEffect(() => {
    if (drawingDisabled) setMode('drag');
  }, [drawingDisabled]);

  // На coarse-устройствах разрешаем drag только в режиме 'drag'. На
  // fine-указателе drag всегда активен, drawing на RMB не мешает.
  const allowDragging = isCoarse && !drawingDisabled ? mode === 'drag' : true;
  const drawingEnabled = !drawingDisabled;

  // На coarse + 'draw'-режим — drawing срабатывает на ЛЮБУЮ кнопку
  // (touch не различает клавиши). На fine — только RMB.
  const drawOnAnyButton = isCoarse && mode === 'draw';

  // Refs для drag-toggle стрелок: запоминаем from-клетку и модификаторы
  // в mouseDown, в mouseUp применяем (как в AnalysisPage L820-913).
  const arrowDragStartRef = useRef<string | null>(null);
  const arrowDragModsRef = useRef<{
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  } | null>(null);

  // Текущие arrows/highlights в КАНОНИЧЕСКОЙ форме (AnnotationColor) —
  // конвертируем из props один раз в render.
  const internalArrows = useMemo<ArrowAnnotation[]>(
    () => (arrows ?? []).map(arrowToInternal),
    [arrows],
  );
  const internalHighlights = useMemo<SquareHighlight[]>(
    () => (highlightedSquares ?? []).map(highlightToInternal),
    [highlightedSquares],
  );

  // squareStyles из highlights — отдаём в Chessboard.options.squareStyles.
  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    for (const h of internalHighlights) {
      styles[h.square] = { backgroundColor: HIGHLIGHT_COLORS[h.color] };
    }
    return styles;
  }, [internalHighlights]);

  // arrows для Chessboard v5: { startSquare, endSquare, color }.
  const boardArrows = useMemo(
    () =>
      internalArrows.map((a) => ({
        startSquare: a.from,
        endSquare: a.to,
        color: HIGHLIGHT_COLORS[a.color],
      })),
    [internalArrows],
  );

  /** Эмит onChange с новым набором arrows/highlights (в DiagramArrow/
   *  DiagramHighlight форме). Остальные поля берём из текущих props. */
  const emit = useCallback(
    (patch: {
      fen?: string;
      caption?: string;
      orientation?: 'white' | 'black';
      arrows?: ArrowAnnotation[];
      highlights?: SquareHighlight[];
    }) => {
      onChange({
        fen: patch.fen ?? fen,
        caption: patch.caption !== undefined ? patch.caption : caption,
        orientation:
          patch.orientation !== undefined ? patch.orientation : orientation,
        arrows: (patch.arrows ?? internalArrows).map(arrowToExternal),
        highlightedSquares: (patch.highlights ?? internalHighlights).map(
          highlightToExternal,
        ),
      });
    },
    [
      onChange,
      fen,
      caption,
      orientation,
      internalArrows,
      internalHighlights,
    ],
  );

  // ----- Drag фигур → меняем FEN -----
  const handlePieceDrop = useCallback(
    (args: {
      sourceSquare: string;
      targetSquare: string | null;
    }): boolean => {
      const { sourceSquare, targetSquare } = args;
      if (!targetSquare || targetSquare === sourceSquare) return false;
      const parsed = fenToBoard(fen);
      const piece = parsed.board[sourceSquare];
      if (!piece) return false;
      // Нелегальные позиции разрешены — просто переставляем фигуру,
      // съедая всё что стоит на target. Иллюстративный редактор.
      const next = { ...parsed.board };
      delete next[sourceSquare];
      next[targetSquare] = piece;
      const nextFen = boardToFen(
        next,
        parsed.turn,
        parsed.castling,
        '-', // ep сбрасываем — после произвольной перестановки невалиден
        parsed.half,
        parsed.full,
      );
      emit({ fen: nextFen });
      return true;
    },
    [fen, emit],
  );

  // ----- Drawing handlers (mouseDown/mouseUp/rightClick) -----
  const handleSquareMouseDown = useCallback(
    (args: { square: string }, e: React.MouseEvent) => {
      if (!drawingEnabled) return;
      if (!drawOnAnyButton && e.button !== 2) return;
      arrowDragStartRef.current = args.square;
      arrowDragModsRef.current = {
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      };
    },
    [drawingEnabled, drawOnAnyButton],
  );

  const handleSquareMouseUp = useCallback(
    (args: { square: string }, e: React.MouseEvent) => {
      if (!drawingEnabled) return;
      const dragStart = arrowDragStartRef.current;
      const dragMods = arrowDragModsRef.current;
      arrowDragStartRef.current = null;
      arrowDragModsRef.current = null;
      if (!dragStart) return;
      if (!drawOnAnyButton && e.button !== 2) return;
      const mods = dragMods ?? {
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      };
      const color = annotationColorByModifiers(mods);

      if (dragStart === args.square) {
        // одиночный клик → toggle highlight
        const idx = internalHighlights.findIndex(
          (h) => h.square === args.square,
        );
        let nextHighlights: SquareHighlight[];
        if (idx >= 0 && internalHighlights[idx].color === color) {
          nextHighlights = internalHighlights
            .slice(0, idx)
            .concat(internalHighlights.slice(idx + 1));
        } else if (idx >= 0) {
          nextHighlights = internalHighlights.slice();
          nextHighlights[idx] = { square: args.square, color };
        } else {
          nextHighlights = internalHighlights.concat({
            square: args.square,
            color,
          });
        }
        emit({ highlights: nextHighlights });
        return;
      }

      // drag → toggle arrow
      const idx = internalArrows.findIndex(
        (a) => a.from === dragStart && a.to === args.square,
      );
      let nextArrows: ArrowAnnotation[];
      if (idx >= 0) {
        nextArrows = internalArrows
          .slice(0, idx)
          .concat(internalArrows.slice(idx + 1));
      } else {
        nextArrows = internalArrows.concat({
          from: dragStart,
          to: args.square,
          color,
        });
      }
      emit({ arrows: nextArrows });
    },
    [
      drawingEnabled,
      drawOnAnyButton,
      emit,
      internalArrows,
      internalHighlights,
    ],
  );

  // Library сама пуляет `onSquareRightClick` на mouseup. Перехватываем
  // и ничего не делаем — вся логика в handleSquareMouseUp. Если не задать
  // handler, library покажет browser context-menu.
  const handleSquareRightClick = useCallback(() => {
    /* handled in mouseUp */
  }, []);

  // ----- Buttons -----
  const handleClearArrows = useCallback(() => {
    emit({ arrows: [] });
  }, [emit]);
  const handleClearHighlights = useCallback(() => {
    emit({ highlights: [] });
  }, [emit]);
  const handleResetFen = useCallback(() => {
    emit({ fen: INITIAL_FEN });
  }, [emit]);

  // ----- Form-style controls -----
  const handleCaptionChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      emit({ caption: e.target.value });
    },
    [emit],
  );

  const handleOrientationChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value === 'black' ? 'black' : 'white';
      emit({ orientation: value });
    },
    [emit],
  );

  return (
    <div className="diagram-editor" data-testid="diagram-editor">
      <div
        className="diagram-editor__board"
        data-testid="diagram-editor-board"
        data-allow-dragging={allowDragging ? 'true' : 'false'}
        data-drawing-enabled={drawingEnabled ? 'true' : 'false'}
        data-mode={mode}
        data-coarse={isCoarse ? 'true' : 'false'}
        data-arrows-count={internalArrows.length}
        data-highlights-count={internalHighlights.length}
        // KS-2571: подавляем браузерное контекстное меню — ПКМ нужен для
        // drawing'а аннотаций.
        onContextMenu={(e) => e.preventDefault()}
      >
        <Chessboard
          options={{
            position: fen,
            boardOrientation: orientation ?? 'white',
            allowDragging,
            showNotation: true,
            animationDurationInMs: 0,
            arrows: boardArrows,
            squareStyles,
            onPieceDrop: handlePieceDrop,
            onSquareMouseDown: drawingEnabled
              ? handleSquareMouseDown
              : undefined,
            onSquareMouseUp: drawingEnabled ? handleSquareMouseUp : undefined,
            onSquareRightClick: drawingEnabled
              ? handleSquareRightClick
              : undefined,
          }}
        />
      </div>

      {!drawingDisabled && isCoarse && (
        <div
          className="diagram-editor__mode-toggle"
          data-testid="diagram-editor-mode-toggle"
          role="group"
          aria-label={t(
            'editor.diagram.modeToggleLabel',
            'Interaction mode',
          )}
        >
          <button
            type="button"
            className={`diagram-editor__mode-btn${mode === 'drag' ? ' diagram-editor__mode-btn--active' : ''}`}
            onClick={() => setMode('drag')}
            data-testid="diagram-editor-mode-drag"
            aria-pressed={mode === 'drag'}
          >
            {t('editor.diagram.modeDrag', 'Drag pieces')}
          </button>
          <button
            type="button"
            className={`diagram-editor__mode-btn${mode === 'draw' ? ' diagram-editor__mode-btn--active' : ''}`}
            onClick={() => setMode('draw')}
            data-testid="diagram-editor-mode-draw"
            aria-pressed={mode === 'draw'}
          >
            {t('editor.diagram.modeDraw', 'Draw arrows')}
          </button>
        </div>
      )}

      {!drawingDisabled && (
        <div className="diagram-editor__tools">
          <button
            type="button"
            className="diagram-editor__tool-btn"
            onClick={handleClearArrows}
            data-testid="diagram-editor-clear-arrows"
          >
            {t('editor.diagram.clearArrows', 'Clear arrows')}
          </button>
          <button
            type="button"
            className="diagram-editor__tool-btn"
            onClick={handleClearHighlights}
            data-testid="diagram-editor-clear-highlights"
          >
            {t('editor.diagram.clearHighlights', 'Clear highlights')}
          </button>
          <button
            type="button"
            className="diagram-editor__tool-btn"
            onClick={handleResetFen}
            data-testid="diagram-editor-reset-fen"
          >
            {t('editor.diagram.resetFen', 'Reset position')}
          </button>
        </div>
      )}

      <div className="diagram-editor__meta">
        <label className="diagram-editor__caption-field">
          <span className="diagram-editor__field-label">
            {t('editor.diagram.caption', 'Caption')}
          </span>
          <input
            type="text"
            className="diagram-editor__caption-input"
            data-testid="diagram-editor-caption-input"
            value={caption ?? ''}
            onChange={handleCaptionChange}
            placeholder={t(
              'editor.diagram.captionPlaceholder',
              'Optional caption…',
            )}
          />
        </label>

        <label className="diagram-editor__orientation-field">
          <span className="diagram-editor__field-label">
            {t('editor.diagram.orientation', 'Orientation')}
          </span>
          <select
            className="diagram-editor__orientation-select"
            data-testid="diagram-editor-orientation-select"
            value={orientation ?? 'white'}
            onChange={handleOrientationChange}
          >
            <option value="white">
              {t('editor.diagram.orientationWhite', 'White at bottom')}
            </option>
            <option value="black">
              {t('editor.diagram.orientationBlack', 'Black at bottom')}
            </option>
          </select>
        </label>
      </div>
    </div>
  );
}

export default DiagramEditor;
