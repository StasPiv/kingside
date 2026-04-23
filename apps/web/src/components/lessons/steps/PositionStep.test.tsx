import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import type { PositionStepPayload } from '@kingside/shared';
import { renderWithProviders, screen, waitFor } from '../../../test/test-utils';
import { PositionStep, parseUci, moveToUci } from './PositionStep';

// ─── Mocks ────────────────────────────────────────────────────────────

// `useSounds` создаёт AudioContext — в jsdom его нет.
vi.mock('../../../hooks/useSounds', () => ({
  useSounds: () => ({ playSound: vi.fn(), muted: false, toggleMute: vi.fn() }),
  soundEventFromSan: () => 'move',
}));

// `useFastDrag` навешивает pointerdown/pointerup на контейнер. В jsdom
// pointer events не эмулируются нативно, и сам тест использует click-to-move
// через `onSquareClick`, так что drag в шагах не нужен.
vi.mock('../../../hooks/useFastDrag', () => ({
  useFastDrag: () => ({ suppressAnimationRef: { current: false } }),
}));

// `MemoChessboard` рендерим как div с ref на переданные `options`. Тесты
// дёргают `options.onSquareClick` напрямую, чтобы сэмулировать клики по
// клеткам — так же, как это делает react-chessboard в реальной доске.
let lastBoardOptions: {
  onSquareClick?: (arg: { piece: unknown; square: string }) => void;
  position?: unknown;
  boardOrientation?: 'white' | 'black';
  squareStyles?: Record<string, React.CSSProperties>;
} | null = null;

vi.mock('../../MemoChessboard', () => ({
  MemoChessboard: (props: { options: typeof lastBoardOptions }) => {
    lastBoardOptions = props.options ?? null;
    return <div data-testid="memo-chessboard" />;
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function clickSquare(square: string) {
  act(() => {
    lastBoardOptions?.onSquareClick?.({ piece: null, square });
  });
}

beforeEach(() => {
  lastBoardOptions = null;
});

// ─── parseUci / moveToUci ────────────────────────────────────────────

describe('parseUci', () => {
  it('валидные UCI', () => {
    expect(parseUci('e2e4')).toEqual({ from: 'e2', to: 'e4', promotion: undefined });
    expect(parseUci('e7e8q')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    expect(parseUci('a1b1N')).toEqual({ from: 'a1', to: 'b1', promotion: 'n' });
  });

  it('мусор → null', () => {
    expect(parseUci('')).toBeNull();
    expect(parseUci('e2')).toBeNull();
    expect(parseUci('e2e4x')).toBeNull();
    expect(parseUci('e2e4qq')).toBeNull();
  });
});

describe('moveToUci', () => {
  it('без promotion', () => {
    expect(moveToUci({ from: 'e2', to: 'e4' })).toBe('e2e4');
  });
  it('с promotion', () => {
    expect(moveToUci({ from: 'e7', to: 'e8', promotion: 'q' })).toBe('e7e8q');
  });
});

// ─── <PositionStep> ───────────────────────────────────────────────────

describe('<PositionStep>', () => {
  it('рендерит доску и индикатор стороны хода из FEN', async () => {
    renderWithProviders(
      <PositionStep
        payload={{
          type: 'position',
          fen: STARTING_FEN,
          expectedMoves: ['e2e4'],
        }}
      />,
    );

    expect(screen.getByTestId('lesson-position-step')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-position-step-turn')).toHaveTextContent('White to move');
    await waitFor(() => expect(lastBoardOptions).not.toBeNull());
    expect(lastBoardOptions?.boardOrientation).toBe('white');
  });

  it('правильный ход → статус correct, onStepDone вызван один раз, кнопка «Next»', async () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <PositionStep
        payload={{
          type: 'position',
          fen: STARTING_FEN,
          expectedMoves: ['e2e4'],
        }}
        onStepDone={onStepDone}
      />,
    );

    await waitFor(() => expect(lastBoardOptions).not.toBeNull());
    clickSquare('e2');
    clickSquare('e4');

    await waitFor(() =>
      expect(screen.getByTestId('lesson-position-step-correct')).toBeInTheDocument(),
    );
    expect(onStepDone).toHaveBeenCalledTimes(1);

    // Ещё один клик не должен ничего делать — step уже done.
    clickSquare('e7');
    clickSquare('e5');
    expect(onStepDone).toHaveBeenCalledTimes(1);

    // Кнопка Next → повторный вызов onStepDone.
    const next = screen.getByTestId('lesson-position-step-next');
    act(() => next.click());
    expect(onStepDone).toHaveBeenCalledTimes(2);
  });

  it('несколько expectedMoves: совпадение с любым засчитывается', async () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <PositionStep
        payload={{
          type: 'position',
          fen: STARTING_FEN,
          expectedMoves: ['d2d4', 'e2e4', 'c2c4'],
        }}
        onStepDone={onStepDone}
      />,
    );
    await waitFor(() => expect(lastBoardOptions).not.toBeNull());
    clickSquare('c2');
    clickSquare('c4');

    await waitFor(() =>
      expect(screen.getByTestId('lesson-position-step-correct')).toBeInTheDocument(),
    );
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('неправильный ход → incorrect, счётчик попыток инкрементится, через откат снова thinking', async () => {
    vi.useFakeTimers();
    try {
      const onStepDone = vi.fn();
      renderWithProviders(
        <PositionStep
          payload={{
            type: 'position',
            fen: STARTING_FEN,
            expectedMoves: ['e2e4'],
          }}
          onStepDone={onStepDone}
        />,
      );
      await vi.waitFor(() => expect(lastBoardOptions).not.toBeNull());

      clickSquare('d2');
      clickSquare('d4');

      await vi.waitFor(() =>
        expect(screen.getByTestId('lesson-position-step-incorrect')).toBeInTheDocument(),
      );
      expect(onStepDone).not.toHaveBeenCalled();
      expect(screen.getByTestId('lesson-position-step-attempts')).toHaveTextContent('1');

      // Перемотка таймера отката.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });

      expect(screen.queryByTestId('lesson-position-step-incorrect')).toBeNull();
      // Кнопка подсказки доступна снова → значит статус thinking.
      expect(screen.getByTestId('lesson-position-step-hint')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('кнопка «Показать подсказку» подсвечивает стартовую клетку первого expectedMove', async () => {
    renderWithProviders(
      <PositionStep
        payload={{
          type: 'position',
          fen: STARTING_FEN,
          expectedMoves: ['e2e4', 'd2d4'],
        }}
      />,
    );
    await waitFor(() => expect(lastBoardOptions).not.toBeNull());
    const hint = screen.getByTestId('lesson-position-step-hint');
    act(() => hint.click());

    await waitFor(() => {
      // squareStyles['e2'] должен содержать backgroundColor (подсветка hint).
      const styles = lastBoardOptions?.squareStyles ?? {};
      expect(styles.e2).toBeDefined();
      expect(styles.e2?.backgroundColor).toBeTruthy();
    });
  });

  it('orientation="black" + FEN с ходом чёрных — доска перевёрнута, turn indicator «чёрные ходят»', async () => {
    const blackToMoveFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    renderWithProviders(
      <PositionStep
        payload={{
          type: 'position',
          fen: blackToMoveFen,
          expectedMoves: ['e7e5'],
          orientation: 'black',
        }}
      />,
    );
    await waitFor(() => expect(lastBoardOptions).not.toBeNull());
    expect(lastBoardOptions?.boardOrientation).toBe('black');
    expect(screen.getByTestId('lesson-position-step-turn')).toHaveTextContent('Black to move');

    clickSquare('e7');
    clickSquare('e5');
    await waitFor(() =>
      expect(screen.getByTestId('lesson-position-step-correct')).toBeInTheDocument(),
    );
  });

  it('нелегальный ход (например, пешка через фигуру) — snap-back, состояние не меняется', async () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <PositionStep
        payload={{
          type: 'position',
          fen: STARTING_FEN,
          expectedMoves: ['e2e4'],
        }}
        onStepDone={onStepDone}
      />,
    );
    await waitFor(() => expect(lastBoardOptions).not.toBeNull());
    // e2→e5 нелегален в стартовой позиции — useBoardHighlights такую клетку
    // не предлагает как legal target, поэтому onMove не вызывается и
    // статус не меняется.
    clickSquare('e2');
    clickSquare('e5');
    expect(screen.queryByTestId('lesson-position-step-correct')).toBeNull();
    expect(screen.queryByTestId('lesson-position-step-incorrect')).toBeNull();
    expect(onStepDone).not.toHaveBeenCalled();
  });
});
