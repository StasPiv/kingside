import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { DiagramArrow, DiagramHighlight } from '@kingside/shared';

import { renderWithProviders } from '../../../../test/test-utils';

/**
 * KS-2571: юнит-тесты shared DiagramEditor.
 *
 * react-chessboard в jsdom не моунтируется адекватно (drag/contextmenu
 * через DOM-events нестабилен), поэтому Chessboard замоканы — публичные
 * хендлеры из props (`onPieceDrop`, `onSquareMouseDown`, `onSquareMouseUp`)
 * выставляются на data-testid'ы как кнопки, чтобы тесты могли их вызвать
 * детерминированно. Это same-pattern как в `CustomPuzzleField.test.tsx`.
 */

let lastChessboardProps: {
  options?: {
    position?: string;
    boardOrientation?: string;
    allowDragging?: boolean;
    arrows?: Array<{ startSquare: string; endSquare: string; color: string }>;
    squareStyles?: Record<string, React.CSSProperties>;
    onPieceDrop?: (args: {
      sourceSquare: string;
      targetSquare: string | null;
    }) => boolean;
    onSquareMouseDown?: (
      args: { square: string },
      e: React.MouseEvent,
    ) => void;
    onSquareMouseUp?: (
      args: { square: string },
      e: React.MouseEvent,
    ) => void;
    onSquareRightClick?: (args: { square: string }) => void;
  };
} = {};

vi.mock('react-chessboard', () => ({
  Chessboard: (props: typeof lastChessboardProps) => {
    lastChessboardProps = props;
    return (
      <div
        data-testid="chessboard-mock"
        data-fen={props.options?.position}
        data-orientation={props.options?.boardOrientation}
        data-allow-dragging={String(props.options?.allowDragging)}
        data-arrows={JSON.stringify(props.options?.arrows ?? [])}
        data-highlights={JSON.stringify(
          Object.keys(props.options?.squareStyles ?? {}),
        )}
        data-has-mouse-down={
          props.options?.onSquareMouseDown ? 'true' : 'false'
        }
      />
    );
  },
}));

import { DiagramEditor } from './DiagramEditor';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface State {
  fen: string;
  caption?: string;
  orientation?: 'white' | 'black';
  arrows: DiagramArrow[];
  highlightedSquares: DiagramHighlight[];
}

function setMatchMedia(coarse: boolean) {
  // Полноценный mock matchMedia — happy-dom возвращает фейковую реализацию,
  // но не управляет matches. Перезаписываем целиком.
  const mql = {
    matches: coarse,
    media: '(pointer:coarse)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockReturnValue(mql),
  });
}

beforeEach(() => {
  lastChessboardProps = {};
  setMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderEditor(initial: Partial<State> = {}, drawingDisabled = false) {
  const onChange = vi.fn<(next: State) => void>();
  const props: State = {
    fen: initial.fen ?? START_FEN,
    caption: initial.caption,
    orientation: initial.orientation ?? 'white',
    arrows: initial.arrows ?? [],
    highlightedSquares: initial.highlightedSquares ?? [],
  };
  const utils = renderWithProviders(
    <DiagramEditor
      fen={props.fen}
      caption={props.caption}
      orientation={props.orientation}
      arrows={props.arrows}
      highlightedSquares={props.highlightedSquares}
      onChange={onChange}
      drawingDisabled={drawingDisabled}
    />,
  );
  return { ...utils, onChange };
}

function makeMouseEvent(
  button: number,
  mods: {
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
  } = {},
): React.MouseEvent {
  return {
    button,
    shiftKey: !!mods.shiftKey,
    altKey: !!mods.altKey,
    ctrlKey: !!mods.ctrlKey,
    metaKey: !!mods.metaKey,
  } as unknown as React.MouseEvent;
}

describe('<DiagramEditor> KS-2571', () => {
  it('рендерит board + caption-input + orientation-select + tools', () => {
    renderEditor();
    expect(screen.getByTestId('diagram-editor')).toBeInTheDocument();
    expect(screen.getByTestId('diagram-editor-board')).toBeInTheDocument();
    expect(screen.getByTestId('diagram-editor-caption-input')).toBeInTheDocument();
    expect(
      screen.getByTestId('diagram-editor-orientation-select'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('diagram-editor-clear-arrows'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('diagram-editor-clear-highlights'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('diagram-editor-reset-fen')).toBeInTheDocument();
  });

  it('передаёт props (FEN, orientation, arrows, highlights) в Chessboard', () => {
    renderEditor({
      fen: START_FEN,
      orientation: 'black',
      arrows: [{ from: 'e2', to: 'e4', color: 'rgba(235, 97, 80, 0.8)' }],
      highlightedSquares: [{ square: 'd5', color: 'rgba(82, 184, 72, 0.8)' }],
    });
    const board = screen.getByTestId('chessboard-mock');
    expect(board.dataset.fen).toBe(START_FEN);
    expect(board.dataset.orientation).toBe('black');
    expect(JSON.parse(board.dataset.arrows!)).toHaveLength(1);
    expect(JSON.parse(board.dataset.highlights!)).toEqual(['d5']);
  });

  it('right-click на клетке (button=2, без модификаторов) → toggle highlight красного цвета', () => {
    const { onChange } = renderEditor();
    // mouseDown на e4 правой кнопкой
    lastChessboardProps.options!.onSquareMouseDown!(
      { square: 'e4' },
      makeMouseEvent(2),
    );
    // mouseUp на той же клетке → одиночный клик
    lastChessboardProps.options!.onSquareMouseUp!(
      { square: 'e4' },
      makeMouseEvent(2),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg.highlightedSquares).toEqual([
      { square: 'e4', color: 'rgba(235, 97, 80, 0.8)' }, // red
    ]);
    expect(arg.arrows).toEqual([]);
  });

  it('right-click + Shift → highlight зелёного цвета', () => {
    const { onChange } = renderEditor();
    lastChessboardProps.options!.onSquareMouseDown!(
      { square: 'd4' },
      makeMouseEvent(2, { shiftKey: true }),
    );
    lastChessboardProps.options!.onSquareMouseUp!(
      { square: 'd4' },
      makeMouseEvent(2, { shiftKey: true }),
    );
    const arg = onChange.mock.calls[0][0];
    expect(arg.highlightedSquares[0].color).toBe('rgba(82, 184, 72, 0.8)');
  });

  it('right-click drag (e2 → e4, button=2) → создаётся стрелка', () => {
    const { onChange } = renderEditor();
    lastChessboardProps.options!.onSquareMouseDown!(
      { square: 'e2' },
      makeMouseEvent(2),
    );
    lastChessboardProps.options!.onSquareMouseUp!(
      { square: 'e4' },
      makeMouseEvent(2),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg.arrows).toEqual([
      { from: 'e2', to: 'e4', color: 'rgba(235, 97, 80, 0.8)' },
    ]);
    expect(arg.highlightedSquares).toEqual([]);
  });

  it('повторный right-click drag по той же стрелке → toggle off (стрелка удаляется)', () => {
    const existing: DiagramArrow[] = [
      { from: 'e2', to: 'e4', color: 'rgba(235, 97, 80, 0.8)' },
    ];
    const { onChange } = renderEditor({ arrows: existing });
    lastChessboardProps.options!.onSquareMouseDown!(
      { square: 'e2' },
      makeMouseEvent(2),
    );
    lastChessboardProps.options!.onSquareMouseUp!(
      { square: 'e4' },
      makeMouseEvent(2),
    );
    const arg = onChange.mock.calls[0][0];
    expect(arg.arrows).toEqual([]);
  });

  it('LMB drag фигур → onPieceDrop меняет FEN, разрешая нелегальные позиции', () => {
    const { onChange } = renderEditor();
    const ok = lastChessboardProps.options!.onPieceDrop!({
      sourceSquare: 'e2',
      targetSquare: 'e5', // нелегальный ход (на 3 клетки), редактор должен разрешить
    });
    expect(ok).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    // На e2 пешка ушла, на e5 появилась P (нелегальный ход разрешён)
    expect(arg.fen).toContain('4P3'); // e5 = P (rank 5, file e=index 4)
    // Ранг 2 потерял пешку: 4 P, 1 пусто, 3 P
    expect(arg.fen).toContain('PPPP1PPP');
  });

  it('кнопка «Очистить стрелки» эмитит onChange с arrows=[]', () => {
    const { onChange } = renderEditor({
      arrows: [{ from: 'e2', to: 'e4', color: 'rgba(235, 97, 80, 0.8)' }],
      highlightedSquares: [{ square: 'd5', color: 'rgba(82, 184, 72, 0.8)' }],
    });
    fireEvent.click(screen.getByTestId('diagram-editor-clear-arrows'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg.arrows).toEqual([]);
    // highlights не трогаем
    expect(arg.highlightedSquares).toHaveLength(1);
  });

  it('кнопка «Очистить выделения» эмитит onChange с highlightedSquares=[]', () => {
    const { onChange } = renderEditor({
      highlightedSquares: [{ square: 'd5', color: 'rgba(82, 184, 72, 0.8)' }],
    });
    fireEvent.click(screen.getByTestId('diagram-editor-clear-highlights'));
    const arg = onChange.mock.calls[0][0];
    expect(arg.highlightedSquares).toEqual([]);
  });

  it('кнопка «Сбросить FEN» эмитит onChange со стартовой позицией', () => {
    const empty = '8/8/8/8/8/8/8/8 w - - 0 1';
    const { onChange } = renderEditor({ fen: empty });
    fireEvent.click(screen.getByTestId('diagram-editor-reset-fen'));
    const arg = onChange.mock.calls[0][0];
    expect(arg.fen).toBe(START_FEN);
  });

  it('caption-input → onChange эмитится с новым caption', () => {
    const { onChange } = renderEditor();
    fireEvent.change(screen.getByTestId('diagram-editor-caption-input'), {
      target: { value: 'New caption' },
    });
    const arg = onChange.mock.calls[0][0];
    expect(arg.caption).toBe('New caption');
  });

  it('orientation-select → onChange эмитится с новой ориентацией', () => {
    const { onChange } = renderEditor();
    fireEvent.change(
      screen.getByTestId('diagram-editor-orientation-select'),
      { target: { value: 'black' } },
    );
    const arg = onChange.mock.calls[0][0];
    expect(arg.orientation).toBe('black');
  });

  it('drawingDisabled=true → drawing-инструменты скрыты, mode-toggle скрыт', () => {
    setMatchMedia(true); // даже на coarse — toggle скрыт при drawingDisabled
    renderEditor({}, true);
    expect(
      screen.queryByTestId('diagram-editor-clear-arrows'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('diagram-editor-clear-highlights'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('diagram-editor-reset-fen'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('diagram-editor-mode-toggle'),
    ).not.toBeInTheDocument();
    // FEN-picker (board) и orientation/caption остаются
    expect(screen.getByTestId('diagram-editor-board')).toBeInTheDocument();
    expect(
      screen.getByTestId('diagram-editor-orientation-select'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('diagram-editor-caption-input'),
    ).toBeInTheDocument();
  });

  it('drawingDisabled=true → onSquareMouseDown НЕ передаётся в Chessboard', () => {
    renderEditor({}, true);
    const board = screen.getByTestId('chessboard-mock');
    expect(board.dataset.hasMouseDown).toBe('false');
  });

  it('mobile (pointer:coarse) → mode-toggle виден; default mode=drag', () => {
    setMatchMedia(true);
    renderEditor();
    const toggle = screen.getByTestId('diagram-editor-mode-toggle');
    expect(toggle).toBeInTheDocument();
    const dragBtn = within(toggle).getByTestId('diagram-editor-mode-drag');
    expect(dragBtn).toHaveAttribute('aria-pressed', 'true');
    // В drag-mode allowDragging=true
    const board = screen.getByTestId('chessboard-mock');
    expect(board.dataset.allowDragging).toBe('true');
  });

  it('mobile mode-toggle: переключение в «Draw arrows» → allowDragging=false', () => {
    setMatchMedia(true);
    renderEditor();
    fireEvent.click(screen.getByTestId('diagram-editor-mode-draw'));
    const board = screen.getByTestId('chessboard-mock');
    expect(board.dataset.allowDragging).toBe('false');
    expect(
      screen.getByTestId('diagram-editor-mode-draw'),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('mobile + draw-mode: mouseDown без button=2 (touch) тоже создаёт arrow', () => {
    setMatchMedia(true);
    const { onChange } = renderEditor();
    fireEvent.click(screen.getByTestId('diagram-editor-mode-draw'));
    onChange.mockClear();
    // touch-симулируем mouseDown с button=0 (LMB)
    lastChessboardProps.options!.onSquareMouseDown!(
      { square: 'e2' },
      makeMouseEvent(0),
    );
    lastChessboardProps.options!.onSquareMouseUp!(
      { square: 'e4' },
      makeMouseEvent(0),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg.arrows).toEqual([
      { from: 'e2', to: 'e4', color: 'rgba(235, 97, 80, 0.8)' },
    ]);
  });

  it('desktop (pointer:fine) → mode-toggle скрыт, allowDragging=true всегда', () => {
    setMatchMedia(false);
    renderEditor();
    expect(
      screen.queryByTestId('diagram-editor-mode-toggle'),
    ).not.toBeInTheDocument();
    const board = screen.getByTestId('chessboard-mock');
    expect(board.dataset.allowDragging).toBe('true');
  });

  it('desktop: LMB (button=0) НЕ создаёт стрелку (drawing только на RMB)', () => {
    setMatchMedia(false);
    const { onChange } = renderEditor();
    lastChessboardProps.options!.onSquareMouseDown!(
      { square: 'e2' },
      makeMouseEvent(0),
    );
    lastChessboardProps.options!.onSquareMouseUp!(
      { square: 'e4' },
      makeMouseEvent(0),
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
