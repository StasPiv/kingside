import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { renderWithProviders, screen } from '../../test/test-utils';

// Мокаем MemoChessboard — даёт fire-buttons по клеткам.
vi.mock('../MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: {
      position?: string;
      onSquareClick?: (a: { piece: unknown; square: string }) => void;
      squareStyles?: Record<string, CSSProperties>;
    };
  }) => {
    const SQUARES = ['e2', 'e4', 'e5', 'd4'];
    return (
      <div data-testid="mock-board" data-position={options.position}>
        {SQUARES.map((sq) => (
          <button
            key={sq}
            type="button"
            data-testid={`fire-square-${sq}`}
            onClick={() => options.onSquareClick?.({ piece: null, square: sq })}
          >
            {sq}
          </button>
        ))}
      </div>
    );
  },
}));

// KS-2318: useFastDrag — мокаем, чтобы зарегистрировать onPieceDrop
// в registry и дёргать через test-only api. Реальный pointer-flow в
// happy-dom тяжело симулировать.
const dropHandlerRegistry: Array<
  ((args: { sourceSquare: string; targetSquare: string | null }) => boolean) | null
> = [];
vi.mock('../../hooks/useFastDrag', () => ({
  useFastDrag: (
    _ref: unknown,
    opts: {
      onPieceDrop: (a: { sourceSquare: string; targetSquare: string | null }) => boolean;
      enabled?: boolean;
    },
  ) => {
    // Регистрируем handler только когда useFastDrag enabled — точно
    // как в production-коде DrillBoard (enabled=!!onPieceDrop).
    if (opts.enabled) {
      dropHandlerRegistry.push(opts.onPieceDrop);
    }
    return { suppressAnimationRef: { current: false } };
  },
}));

function fireDrop(args: { sourceSquare: string; targetSquare: string }) {
  const handler = dropHandlerRegistry[dropHandlerRegistry.length - 1];
  if (!handler) throw new Error('no drop handler registered');
  return handler(args);
}

/**
 * KS-2319: для тестов где нужно «заморозить» feedback (проверить
 * data-result, progress, drop в feedback), отключаем reduced-motion
 * локально + ставим autoNextDelayMs=60s.
 */
function disableReducedMotion() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

import { DrillRunner } from './DrillRunner';

const NUMBER_DRILL = {
  id: 'd-num',
  drillType: 'count-attackers',
  fen: '8/8/8/4p3/4P3/8/8/8 w - - 0 1',
  sideToMove: null,
  answerShape: 'number',
  difficulty: 1,
  meta: { highlightedSquare: 'e5' },
};

const SQUARE_DRILL = {
  id: 'd-sq',
  drillType: 'find-pin',
  fen: '8/8/8/8/4P3/8/8/8 w - - 0 1',
  sideToMove: 'w',
  answerShape: 'square',
  difficulty: 2,
};

beforeEach(() => {
  vi.useRealTimers();
  dropHandlerRegistry.length = 0;
  // KS-2319: тестируем как при prefers-reduced-motion → авто-переход
  // мгновенный, тесты не ждут 1.5с. Конкретные тесты на delay/reduced
  // переопределяют локально.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<DrillRunner> KS-2249', () => {
  it('mount → loading → idle, дёргает loadDrill один раз', async () => {
    const loadDrill = vi.fn(async () => NUMBER_DRILL);
    const submitAnswer = vi.fn();
    renderWithProviders(
      <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
    );
    expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
      'loading',
    );
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    expect(loadDrill).toHaveBeenCalledTimes(1);
  });

  it('shape=number: клик «2» → submitAnswer({shape:number,value:2}, drillId)', async () => {
    const loadDrill = vi.fn(async () => NUMBER_DRILL);
    const submitAnswer = vi.fn(async () => ({
      attemptId: 'a1',
      solved: true,
      correctAnswer: { shape: 'number', value: 2 },
    }));
    const user = userEvent.setup();
    renderWithProviders(
      <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('drill-count-attackers-btn-2'));
    await waitFor(() =>
      expect(submitAnswer).toHaveBeenCalledWith(
        expect.objectContaining({
          drillId: 'd-num',
          userAnswer: { shape: 'number', value: 2 },
        }),
      ),
    );
  });

  it('после правильного submit → state=feedback с зелёной подсветкой + counter 1/1', async () => {
    disableReducedMotion();
    const loadDrill = vi.fn(async () => NUMBER_DRILL);
    const submitAnswer = vi.fn(async () => ({
      attemptId: 'a1',
      solved: true,
      correctAnswer: { shape: 'number', value: 2 },
    }));
    const user = userEvent.setup();
    renderWithProviders(
      // KS-2319: большой autoNextDelayMs — заморозить state в feedback,
      // чтобы успеть проверить data-result/progress до авто-перехода.
      <DrillRunner
        loadDrill={loadDrill}
        submitAnswer={submitAnswer}
        autoNextDelayMs={60_000}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('drill-count-attackers-btn-2'));
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'feedback',
      ),
    );
    expect(screen.getByTestId('drill-feedback').getAttribute('data-result')).toBe(
      'correct',
    );
    const progress = screen.getByTestId('drill-runner-progress');
    expect(progress.getAttribute('data-attempted')).toBe('1');
    expect(progress.getAttribute('data-solved')).toBe('1');
  });

  it('count=1 + 1 правильный submit → done с success=true + onComplete вызван', async () => {
    const loadDrill = vi.fn(async () => SQUARE_DRILL);
    const submitAnswer = vi.fn(async () => ({
      attemptId: 'a1',
      solved: true,
      correctAnswer: { shape: 'square', square: 'e4' },
    }));
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillRunner
        loadDrill={loadDrill}
        submitAnswer={submitAnswer}
        count={1}
        minSolved={1}
        onComplete={onComplete}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('fire-square-e4'));
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'feedback',
      ),
    );

    // KS-2319: авто-переход (matchMedia reduced=true → delay=0).
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'done',
      ),
    );
    expect(
      screen.getByTestId('drill-runner').getAttribute('data-success'),
    ).toBe('true');
    expect(onComplete).toHaveBeenCalledWith({
      solved: 1,
      attempted: 1,
      success: true,
    });
    // Continue-кнопка показана для success.
    expect(screen.getByTestId('drill-runner-continue')).toBeInTheDocument();
  });

  it('count=2 + minSolved=2 + 1 правильный + 1 неправильный → done success=false, retry-кнопка', async () => {
    const loadDrill = vi
      .fn()
      .mockResolvedValueOnce(SQUARE_DRILL)
      .mockResolvedValueOnce({ ...SQUARE_DRILL, id: 'd-sq-2' })
      .mockResolvedValueOnce(SQUARE_DRILL);
    let callIdx = 0;
    const submitAnswer = vi.fn(async () => {
      callIdx += 1;
      return {
        attemptId: `a${callIdx}`,
        // Первый раз правильно, второй — нет.
        solved: callIdx === 1,
        correctAnswer: { shape: 'square', square: 'e4' },
      };
    });
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillRunner
        loadDrill={loadDrill}
        submitAnswer={submitAnswer}
        count={2}
        minSolved={2}
        onComplete={onComplete}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    // Submit #1 (правильный).
    await user.click(screen.getByTestId('fire-square-e4'));
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'feedback',
      ),
    );
    // KS-2319: авто-переход (matchMedia reduced=true → delay=0).
    // Loading → idle следующего drill'а.
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    // Submit #2 (неправильный — d4 вместо e4).
    await user.click(screen.getByTestId('fire-square-d4'));
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'feedback',
      ),
    );
    // KS-2319: авто-переход (matchMedia reduced=true → delay=0).
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'done',
      ),
    );
    expect(
      screen.getByTestId('drill-runner').getAttribute('data-success'),
    ).toBe('false');
    expect(onComplete).toHaveBeenCalledWith({
      solved: 1,
      attempted: 2,
      success: false,
    });
    expect(screen.getByTestId('drill-runner-retry')).toBeInTheDocument();
  });

  it('count=2 minSolved=1 + 1 правильный + 1 неправильный → done success=true', async () => {
    const loadDrill = vi
      .fn()
      .mockResolvedValueOnce(SQUARE_DRILL)
      .mockResolvedValueOnce({ ...SQUARE_DRILL, id: 'd-sq-2' });
    let callIdx = 0;
    const submitAnswer = vi.fn(async () => {
      callIdx += 1;
      return {
        attemptId: `a${callIdx}`,
        solved: callIdx === 1,
        correctAnswer: { shape: 'square', square: 'e4' },
      };
    });
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillRunner
        loadDrill={loadDrill}
        submitAnswer={submitAnswer}
        count={2}
        minSolved={1}
        onComplete={onComplete}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('fire-square-e4'));
    // KS-2319: авто-переход (matchMedia reduced=true → delay=0).
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('fire-square-d4'));
    // KS-2319: авто-переход (matchMedia reduced=true → delay=0).
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'done',
      ),
    );
    expect(onComplete).toHaveBeenCalledWith({
      solved: 1,
      attempted: 2,
      success: true,
    });
  });

  it('count=Infinity (default) → после feedback Next грузит следующий drill, в done не уходит', async () => {
    const loadDrill = vi
      .fn()
      .mockResolvedValueOnce(SQUARE_DRILL)
      .mockResolvedValueOnce({ ...SQUARE_DRILL, id: 'd-sq-2' });
    const submitAnswer = vi.fn(async () => ({
      attemptId: 'a1',
      solved: true,
      correctAnswer: { shape: 'square', square: 'e4' },
    }));
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillRunner
        loadDrill={loadDrill}
        submitAnswer={submitAnswer}
        onComplete={onComplete}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('fire-square-e4'));
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'feedback',
      ),
    );
    // KS-2319: авто-переход (matchMedia reduced=true → delay=0).
    // Должен снова стать idle (новый drill), а НЕ done.
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    expect(loadDrill).toHaveBeenCalledTimes(2);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('headerSlot рендерится во всех состояниях (loading/idle/feedback/done/error)', async () => {
    const loadDrill = vi.fn(async () => SQUARE_DRILL);
    const submitAnswer = vi.fn();
    const headerSlot = <div data-testid="custom-header">CUSTOM</div>;
    renderWithProviders(
      <DrillRunner
        loadDrill={loadDrill}
        submitAnswer={submitAnswer}
        headerSlot={headerSlot}
      />,
    );
    expect(screen.getByTestId('custom-header')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    expect(screen.getByTestId('custom-header')).toBeInTheDocument();
  });

  // KS-2318: drag-and-drop для shape='move'.
  describe('KS-2318 — drag-and-drop ввод хода (shape=move)', () => {
    const MOVE_DRILL = {
      id: 'd-move',
      drillType: 'find-undefended-attack',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1',
      sideToMove: 'w',
      answerShape: 'move',
      difficulty: 3,
    };

    it('useFastDrag enabled только для shape=move (для number — нет registry)', async () => {
      const loadDrill = vi.fn(async () => NUMBER_DRILL);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      // shape=number → onPieceDrop НЕ передаётся в DrillBoard → useFastDrag не enabled.
      expect(dropHandlerRegistry).toHaveLength(0);
    });

    it('shape=move: useFastDrag регистрирует handler', async () => {
      const loadDrill = vi.fn(async () => MOVE_DRILL);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      expect(dropHandlerRegistry.length).toBeGreaterThan(0);
    });

    it('drag e2→e4 → submit({shape:move, from:e2, to:e4})', async () => {
      const loadDrill = vi.fn(async () => MOVE_DRILL);
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'move', from: 'e2', to: 'e4' },
      }));
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      // Симулируем drop через зарегистрированный handler.
      const accepted = fireDrop({ sourceSquare: 'e2', targetSquare: 'e4' });
      expect(accepted).toBe(true);
      await waitFor(() =>
        expect(submitAnswer).toHaveBeenCalledWith(
          expect.objectContaining({
            drillId: 'd-move',
            userAnswer: { shape: 'move', from: 'e2', to: 'e4' },
          }),
        ),
      );
    });

    it('drop с одинаковыми from/to (no-op) → submit НЕ вызван', async () => {
      const loadDrill = vi.fn(async () => MOVE_DRILL);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      const accepted = fireDrop({ sourceSquare: 'e2', targetSquare: 'e2' });
      expect(accepted).toBe(false);
      expect(submitAnswer).not.toHaveBeenCalled();
    });

    it('drop когда state≠idle (например, в feedback) → submit НЕ вызван', async () => {
      disableReducedMotion();
      const loadDrill = vi.fn(async () => MOVE_DRILL);
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'move', from: 'e2', to: 'e4' },
      }));
      const user = userEvent.setup();
      renderWithProviders(
        <DrillRunner
          loadDrill={loadDrill}
          submitAnswer={submitAnswer}
          autoNextDelayMs={60_000}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      // Сначала click-click → feedback.
      await user.click(screen.getByTestId('fire-square-e2'));
      await user.click(screen.getByTestId('fire-square-e4'));
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'feedback',
        ),
      );
      const callsBeforeDrop = submitAnswer.mock.calls.length;
      // Drop в feedback-state — игнорируется.
      const accepted = fireDrop({ sourceSquare: 'd2', targetSquare: 'd4' });
      expect(accepted).toBe(false);
      expect(submitAnswer.mock.calls.length).toBe(callsBeforeDrop);
    });

    it('shape=move: click-click и drag сосуществуют (click-click продолжает работать)', async () => {
      const loadDrill = vi.fn(async () => MOVE_DRILL);
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'move', from: 'e2', to: 'e4' },
      }));
      const user = userEvent.setup();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      // Click-click flow остаётся живым.
      await user.click(screen.getByTestId('fire-square-e2'));
      await user.click(screen.getByTestId('fire-square-e4'));
      await waitFor(() =>
        expect(submitAnswer).toHaveBeenCalledWith(
          expect.objectContaining({
            userAnswer: { shape: 'move', from: 'e2', to: 'e4' },
          }),
        ),
      );
    });
  });

  // KS-2319: авто-переход после feedback (кнопка «Следующее» удалена).
  describe('KS-2319 — авто-переход после feedback', () => {
    it('кнопка drill-runner-next физически удалена (не рендерится в feedback)', async () => {
      disableReducedMotion();
      const loadDrill = vi.fn(async () => SQUARE_DRILL);
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'square', square: 'e4' },
      }));
      const user = userEvent.setup();
      renderWithProviders(
        <DrillRunner
          loadDrill={loadDrill}
          submitAnswer={submitAnswer}
          // Заморозим feedback на 60s — гарантировано не успеет уйти.
          autoNextDelayMs={60_000}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      await user.click(screen.getByTestId('fire-square-e4'));
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'feedback',
        ),
      );
      expect(screen.queryByTestId('drill-runner-next')).not.toBeInTheDocument();
    });

    it('правильный ответ + autoNextDelayMs=0 → loadDrill вызван второй раз (авто-переход)', async () => {
      const loadDrill = vi
        .fn()
        .mockResolvedValueOnce(SQUARE_DRILL)
        .mockResolvedValueOnce({ ...SQUARE_DRILL, id: 'd-sq-2' });
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'square', square: 'e4' },
      }));
      const user = userEvent.setup();
      renderWithProviders(
        <DrillRunner
          loadDrill={loadDrill}
          submitAnswer={submitAnswer}
          autoNextDelayMs={0}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      await user.click(screen.getByTestId('fire-square-e4'));
      await waitFor(() => expect(loadDrill).toHaveBeenCalledTimes(2));
    });

    it('неверный ответ → авто-переход тоже срабатывает (одинаковое поведение)', async () => {
      const loadDrill = vi
        .fn()
        .mockResolvedValueOnce(SQUARE_DRILL)
        .mockResolvedValueOnce({ ...SQUARE_DRILL, id: 'd-sq-2' });
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: false,
        correctAnswer: { shape: 'square', square: 'e4' },
      }));
      const user = userEvent.setup();
      renderWithProviders(
        <DrillRunner
          loadDrill={loadDrill}
          submitAnswer={submitAnswer}
          autoNextDelayMs={0}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      // Кликаем НЕ-правильный ответ (mock всё равно вернёт solved:false).
      await user.click(screen.getByTestId('fire-square-d4'));
      await waitFor(() => expect(loadDrill).toHaveBeenCalledTimes(2));
    });

    it('prefers-reduced-motion=reduce → delay переопределяется на 0 (даже если autoNextDelayMs=60s)', async () => {
      const loadDrill = vi
        .fn()
        .mockResolvedValueOnce(SQUARE_DRILL)
        .mockResolvedValueOnce({ ...SQUARE_DRILL, id: 'd-sq-2' });
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'square', square: 'e4' },
      }));
      const user = userEvent.setup();
      // beforeEach уже вернул reduced=true. Несмотря на autoNextDelayMs=60s,
      // prefersReducedMotion() override на 0 → переход мгновенный.
      renderWithProviders(
        <DrillRunner
          loadDrill={loadDrill}
          submitAnswer={submitAnswer}
          autoNextDelayMs={60_000}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      await user.click(screen.getByTestId('fire-square-e4'));
      // Должен дойти до loadDrill #2 МГНОВЕННО (не ждём 60с).
      await waitFor(() => expect(loadDrill).toHaveBeenCalledTimes(2));
    });

    it('count=1 + правильный ответ → авто-переход → done (НЕ fetchNext)', async () => {
      const loadDrill = vi.fn(async () => SQUARE_DRILL);
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'square', square: 'e4' },
      }));
      const onComplete = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <DrillRunner
          loadDrill={loadDrill}
          submitAnswer={submitAnswer}
          count={1}
          minSolved={1}
          onComplete={onComplete}
          autoNextDelayMs={0}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      await user.click(screen.getByTestId('fire-square-e4'));
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'done',
        ),
      );
      // loadDrill = 1 (initial). Второго вызова не должно — done.
      expect(loadDrill).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith({
        solved: 1,
        attempted: 1,
        success: true,
      });
    });
  });

  it('hideProgress + hideTimer → блоки не рендерятся', async () => {
    const loadDrill = vi.fn(async () => SQUARE_DRILL);
    const submitAnswer = vi.fn();
    renderWithProviders(
      <DrillRunner
        loadDrill={loadDrill}
        submitAnswer={submitAnswer}
        hideProgress
        hideTimer
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    expect(screen.queryByTestId('drill-runner-progress')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drill-runner-timer')).not.toBeInTheDocument();
  });
});
