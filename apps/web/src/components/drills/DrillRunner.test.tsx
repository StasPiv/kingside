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
        autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={60_000}
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
          autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={60_000}
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

    // KS-2405: ход чужой фигурой не должен запускать submit, просто
    // игнорируется на этапе ввода — никакого «неверно» в статистике.
    it('KS-2405: первый click по чужой фигуре игнорируется (submit НЕ вызван)', async () => {
      const loadDrill = vi.fn(async () => MOVE_DRILL);
      const submitAnswer = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      // MOVE_DRILL: ход белых, e5 — чёрная пешка. Первый клик по ней
      // должен быть проигнорирован (pickedFrom не выставится), второй
      // клик на e4 не сложит ход — submit НЕ вызывается.
      await user.click(screen.getByTestId('fire-square-e5'));
      await user.click(screen.getByTestId('fire-square-e4'));
      expect(submitAnswer).not.toHaveBeenCalled();
    });

    it('KS-2405: drag чужой фигурой не вызывает submit', async () => {
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
      // useFastDrag сам блокирует drag не своих фигур, но дублирующая
      // защита в handlePieceDrop отбрасывает то, что прошло мимо хука.
      // MOVE_DRILL: ход белых, e5 — чёрная пешка.
      const accepted = fireDrop({ sourceSquare: 'e5', targetSquare: 'e4' });
      expect(accepted).toBe(false);
      expect(submitAnswer).not.toHaveBeenCalled();
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
          autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={60_000}
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
          autoNextDelayCorrectMs={0}
          autoNextDelayIncorrectMs={0}
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
          autoNextDelayCorrectMs={0}
          autoNextDelayIncorrectMs={0}
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
          autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={60_000}
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

    // KS-2323: разные delay для правильного / неверного ответа.
    it('KS-2323: правильный ответ + correct=0 / incorrect=60s → авто-переход МГНОВЕННЫЙ (НЕ ждёт 60с)', async () => {
      disableReducedMotion();
      const loadDrill = vi
        .fn()
        .mockResolvedValueOnce(SQUARE_DRILL)
        .mockResolvedValueOnce({ ...SQUARE_DRILL, id: 'd-sq-2' });
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true, // правильный
        correctAnswer: { shape: 'square', square: 'e4' },
      }));
      const user = userEvent.setup();
      renderWithProviders(
        <DrillRunner
          loadDrill={loadDrill}
          submitAnswer={submitAnswer}
          autoNextDelayCorrectMs={0}
          autoNextDelayIncorrectMs={60_000}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      await user.click(screen.getByTestId('fire-square-e4'));
      // Правильный → correct delay = 0 → loadDrill #2 сразу.
      await waitFor(() => expect(loadDrill).toHaveBeenCalledTimes(2));
    });

    it('KS-2323: НЕВЕРНЫЙ ответ + correct=60s / incorrect=0 → авто-переход МГНОВЕННЫЙ (по incorrect-delay)', async () => {
      disableReducedMotion();
      const loadDrill = vi
        .fn()
        .mockResolvedValueOnce(SQUARE_DRILL)
        .mockResolvedValueOnce({ ...SQUARE_DRILL, id: 'd-sq-2' });
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: false, // неверный
        correctAnswer: { shape: 'square', square: 'e4' },
      }));
      const user = userEvent.setup();
      renderWithProviders(
        <DrillRunner
          loadDrill={loadDrill}
          submitAnswer={submitAnswer}
          autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={0}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      await user.click(screen.getByTestId('fire-square-d4'));
      // Неверный → incorrect delay = 0 → loadDrill #2 сразу
      // (correct=60s НЕ влияет, потому что ответ неверный).
      await waitFor(() => expect(loadDrill).toHaveBeenCalledTimes(2));
    });

    it('KS-2323: НЕВЕРНЫЙ ответ + correct=0 / incorrect=60s → застрял в feedback (ждёт incorrect-delay)', async () => {
      disableReducedMotion();
      const loadDrill = vi.fn(async () => SQUARE_DRILL);
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
          autoNextDelayCorrectMs={0}
          autoNextDelayIncorrectMs={60_000}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      await user.click(screen.getByTestId('fire-square-d4'));
      // Зайдём в feedback и убедимся что НЕ перешли к next за 100мс
      // (incorrect=60s ещё не истёк, correct=0 не применяется).
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'feedback',
        ),
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(loadDrill).toHaveBeenCalledTimes(1); // только initial
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'feedback',
      );
    });

    it('KS-2323 + reduced-motion: оба delay → 0, неверный тоже мгновенно', async () => {
      // beforeEach уже вернул reduced=true.
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
          autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={60_000}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      await user.click(screen.getByTestId('fire-square-d4'));
      // reduced=true → override на 0, переход моментальный, несмотря на 60s.
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
          autoNextDelayCorrectMs={0}
          autoNextDelayIncorrectMs={0}
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

  // KS-2367: для count-attackers с meta.attackerColor показываем цвет
  // атакующих в вопросе и индикатор цвета.
  describe('KS-2367 — count-attackers: цвет атакующих в вопросе', () => {
    const COUNT_DRILL_WHITE = {
      id: 'd-cnt-w',
      drillType: 'count-attackers',
      fen: '8/8/8/4p3/4P3/8/8/8 w - - 0 1',
      sideToMove: null,
      answerShape: 'number',
      difficulty: 1,
      meta: { highlightedSquare: 'e5', attackerColor: 'w' },
    };
    const COUNT_DRILL_BLACK = {
      ...COUNT_DRILL_WHITE,
      id: 'd-cnt-b',
      meta: { highlightedSquare: 'e5', attackerColor: 'b' },
    };
    const COUNT_DRILL_NO_COLOR = {
      ...COUNT_DRILL_WHITE,
      id: 'd-cnt-no',
      meta: { highlightedSquare: 'e5' },
    };

    it("attackerColor='w' → инструкция WHITE + индикатор data-side='w'", async () => {
      const loadDrill = vi.fn(async () => COUNT_DRILL_WHITE);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      expect(
        screen.getByTestId('drill-instructions').textContent,
      ).toMatch(/WHITE|БЕЛЫХ/);
      const indicator = screen.getByTestId('drill-runner-attacker-color');
      expect(indicator.getAttribute('data-side')).toBe('w');
    });

    it("attackerColor='b' → инструкция BLACK + индикатор data-side='b'", async () => {
      const loadDrill = vi.fn(async () => COUNT_DRILL_BLACK);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      expect(
        screen.getByTestId('drill-instructions').textContent,
      ).toMatch(/BLACK|ЧЁРНЫХ/);
      expect(
        screen.getByTestId('drill-runner-attacker-color').getAttribute('data-side'),
      ).toBe('b');
    });

    it('нет meta.attackerColor → старая инструкция, индикатор скрыт (back-compat)', async () => {
      const loadDrill = vi.fn(async () => COUNT_DRILL_NO_COLOR);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      expect(
        screen.getByTestId('drill-instructions').textContent ?? '',
      ).not.toMatch(/WHITE|BLACK|БЕЛЫХ|ЧЁРНЫХ/);
      expect(
        screen.queryByTestId('drill-runner-attacker-color'),
      ).not.toBeInTheDocument();
    });
  });

  // KS-2452: своя фигура на target-клетке → defenders, а не attackers.
  // Текст вопроса и pill переключаются по правилу:
  // pieceColorOnSquare(highlightedSquare) === attackerColor → defenders.
  describe('KS-2452 — count-attackers: своя фигура → защищают', () => {
    // FEN: чёрная пешка на e5, белая пешка на e4. Короли добавлены,
    // чтобы chess.js принял FEN (наш pieceColorOnSquare вернул бы null
    // на FEN без королей и тест-кейс не отличал бы defenders от
    // attackers).
    const FEN = '4k3/8/8/4p3/4P3/8/8/4K3 w - - 0 1';

    async function load(meta: { highlightedSquare: string; attackerColor: 'w' | 'b' }) {
      const drill = {
        id: 'd-cnt-def',
        drillType: 'count-attackers',
        fen: FEN,
        sideToMove: null,
        answerShape: 'number',
        difficulty: 1,
        meta,
      };
      const loadDrill = vi.fn(async () => drill);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
    }

    it("attackerColor='b' и на target чёрная фигура → 'defend'/'защищают' + pill 'defenders'", async () => {
      await load({ highlightedSquare: 'e5', attackerColor: 'b' });
      const text = screen.getByTestId('drill-instructions').textContent ?? '';
      expect(text).toMatch(/defend|защищают/i);
      expect(text).not.toMatch(/attack(s)?\b|атакуют/i);
      const pill = screen.getByTestId('drill-runner-attacker-color');
      expect(pill.getAttribute('data-role')).toBe('defenders');
      expect(pill.textContent).toMatch(/defender|защищающие/i);
    });

    it("attackerColor='w' и на target белая фигура → 'defend'/'защищают' + pill 'defenders'", async () => {
      await load({ highlightedSquare: 'e4', attackerColor: 'w' });
      const text = screen.getByTestId('drill-instructions').textContent ?? '';
      expect(text).toMatch(/defend|защищают/i);
      const pill = screen.getByTestId('drill-runner-attacker-color');
      expect(pill.getAttribute('data-role')).toBe('defenders');
    });

    it("attackerColor='w' и на target чужая фигура (чёрная) → 'attack'/'атакуют' + pill 'attackers'", async () => {
      await load({ highlightedSquare: 'e5', attackerColor: 'w' });
      const text = screen.getByTestId('drill-instructions').textContent ?? '';
      expect(text).toMatch(/attack|атакуют/i);
      expect(text).not.toMatch(/defend|защищают/i);
      const pill = screen.getByTestId('drill-runner-attacker-color');
      expect(pill.getAttribute('data-role')).toBe('attackers');
    });

    it("пустая клетка → 'attack'/'атакуют' (defenders применимо только при своей фигуре)", async () => {
      await load({ highlightedSquare: 'd4', attackerColor: 'w' });
      const text = screen.getByTestId('drill-instructions').textContent ?? '';
      expect(text).toMatch(/attack|атакуют/i);
      expect(text).not.toMatch(/defend|защищают/i);
      const pill = screen.getByTestId('drill-runner-attacker-color');
      expect(pill.getAttribute('data-role')).toBe('attackers');
    });
  });

  // KS-2335 / KS-2337 / KS-2341: find-hanging-piece переведён на
  // answerShape='move' — drill требует ход-взятие, а не клик клетки.
  describe("KS-2341 — find-hanging-piece под shape='move'", () => {
    const HANGING_MOVE_DRILL = {
      id: 'd-hang-move',
      drillType: 'find-hanging-piece',
      // KS-2405: ход БЕЛЫХ. Раньше fen ставил `b` (ход чёрных), e2 —
      // белая пешка-чужак, и юзер симулировал «ход чужой фигурой» — это
      // работало по старому поведению. После KS-2405 первый клик /
      // drag по чужой фигуре блокируется, тест опирается на drag/click
      // СВОЕЙ фигуры. Семантика теста не меняется (всё ещё проверяем
      // что move e2→e4 → submit), просто side выровнен с фигурой.
      fen: '7k/8/8/8/8/8/4P3/4K2R w - - 0 1',
      sideToMove: 'w',
      answerShape: 'move',
      difficulty: 1,
    };

    it("click-click e2→e4 → submit({shape:'move',from:'e2',to:'e4'}) и НЕ shape='square'", async () => {
      const loadDrill = vi.fn(async () => HANGING_MOVE_DRILL);
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
      await user.click(screen.getByTestId('fire-square-e2'));
      await user.click(screen.getByTestId('fire-square-e4'));
      await waitFor(() =>
        expect(submitAnswer).toHaveBeenCalledWith(
          expect.objectContaining({
            drillId: 'd-hang-move',
            userAnswer: { shape: 'move', from: 'e2', to: 'e4' },
          }),
        ),
      );
    });

    it('drag e2→e4 → submit({shape:move,from:e2,to:e4})', async () => {
      const loadDrill = vi.fn(async () => HANGING_MOVE_DRILL);
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
      // Drag-handler регистрируется через useFastDrag mock, проверяем
      // что для shape='move' он включён.
      expect(dropHandlerRegistry.length).toBeGreaterThan(0);
      const accepted = fireDrop({ sourceSquare: 'e2', targetSquare: 'e4' });
      expect(accepted).toBe(true);
      await waitFor(() =>
        expect(submitAnswer).toHaveBeenCalledWith(
          expect.objectContaining({
            drillId: 'd-hang-move',
            userAnswer: { shape: 'move', from: 'e2', to: 'e4' },
          }),
        ),
      );
    });
  });

  // KS-2333: side-to-move индикатор для side-sensitive drill-типов.
  describe('KS-2333 — индикатор стороны для side-sensitive drill-типов', () => {
    const LOOSE_PIECE_WHITE = {
      id: 'd-loose-w',
      drillType: 'find-loose-piece',
      // Backend контрактом отдаёт sideToMove=null для find-loose-piece,
      // FEN — реальный источник правды (второе поле = 'w').
      fen: 'r6k/8/8/8/8/8/8/R6K w - - 0 1',
      sideToMove: null,
      answerShape: 'square',
      difficulty: 1,
    };
    const LOOSE_PIECE_BLACK = {
      ...LOOSE_PIECE_WHITE,
      id: 'd-loose-b',
      fen: 'r6k/8/8/8/8/8/8/R6K b - - 0 1',
    };
    const HANGING_PIECE_BLACK = {
      id: 'd-hang-b',
      drillType: 'find-hanging-piece',
      fen: 'r6k/8/8/8/8/8/8/R6K b - - 0 1',
      // KS-2337/KS-2341: find-hanging-piece переведён на shape='move'.
      // sideToMove оставлен null — проверяем fallback из FEN
      // (KS-2333 SIDE_SENSITIVE_DRILL_TYPES).
      sideToMove: null,
      answerShape: 'move',
      difficulty: 2,
    };
    const PIN_DRILL = {
      id: 'd-pin',
      drillType: 'find-pin',
      fen: 'r6k/8/8/8/8/8/8/R6K w - - 0 1',
      sideToMove: null,
      answerShape: 'square',
      difficulty: 1,
    };

    it('find-loose-piece + sideToMove=null + FEN(w) → индикатор виден с data-side="w"', async () => {
      const loadDrill = vi.fn(async () => LOOSE_PIECE_WHITE);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      const side = screen.getByTestId('drill-runner-side');
      expect(side).toBeInTheDocument();
      expect(side.getAttribute('data-side')).toBe('w');
    });

    it('find-loose-piece + FEN(b) → индикатор data-side="b"', async () => {
      const loadDrill = vi.fn(async () => LOOSE_PIECE_BLACK);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      const side = screen.getByTestId('drill-runner-side');
      expect(side.getAttribute('data-side')).toBe('b');
    });

    it('find-hanging-piece + sideToMove=null → fallback из FEN тоже работает', async () => {
      const loadDrill = vi.fn(async () => HANGING_PIECE_BLACK);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      expect(
        screen.getByTestId('drill-runner-side').getAttribute('data-side'),
      ).toBe('b');
    });

    it('find-pin + sideToMove=null → индикатор НЕ показывается (тип не side-sensitive)', async () => {
      const loadDrill = vi.fn(async () => PIN_DRILL);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      expect(screen.queryByTestId('drill-runner-side')).not.toBeInTheDocument();
    });

    it('drill.sideToMove задан явно → имеет приоритет над FEN', async () => {
      // FEN c 'b', а sideToMove='w' — должен победить sideToMove.
      const drill = {
        id: 'd-explicit',
        drillType: 'find-loose-piece',
        fen: 'r6k/8/8/8/8/8/8/R6K b - - 0 1',
        sideToMove: 'w',
        answerShape: 'square',
        difficulty: 1,
      };
      const loadDrill = vi.fn(async () => drill);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      expect(
        screen.getByTestId('drill-runner-side').getAttribute('data-side'),
      ).toBe('w');
    });
  });

  // KS-2330: навигация по локальной истории drill'ов (Назад/Вперёд).
  describe('KS-2330 — локальная история drill\'ов (Назад / Вперёд)', () => {
    it('первый mount: «Назад» disabled, «Вперёд» disabled (история = 1, без feedback)', async () => {
      const loadDrill = vi.fn(async () => SQUARE_DRILL);
      const submitAnswer = vi.fn();
      renderWithProviders(
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      expect(screen.getByTestId('drill-runner-back')).toBeDisabled();
      expect(screen.getByTestId('drill-runner-forward')).toBeDisabled();
      expect(
        screen.getByTestId('drill-runner').getAttribute('data-history-size'),
      ).toBe('1');
      expect(
        screen.getByTestId('drill-runner').getAttribute('data-history-index'),
      ).toBe('0');
    });

    it('после авто-перехода (drill #2) «Назад» доступна, история=2', async () => {
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
        <DrillRunner loadDrill={loadDrill} submitAnswer={submitAnswer} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      await user.click(screen.getByTestId('fire-square-e4'));
      // Авто-переход (reduced=true → delay=0) → idle drill #2.
      await waitFor(() => expect(loadDrill).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      expect(
        screen.getByTestId('drill-runner').getAttribute('data-history-size'),
      ).toBe('2');
      expect(screen.getByTestId('drill-runner-back')).not.toBeDisabled();
    });

    it('«Назад» восстанавливает прошлый drill вместе с feedback (его ответом и результатом)', async () => {
      const loadDrill = vi
        .fn()
        .mockResolvedValueOnce(SQUARE_DRILL)
        .mockResolvedValueOnce({ ...SQUARE_DRILL, id: 'd-sq-2', fen: '8/8/8/8/8/8/8/8 w - - 0 1' });
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'square', square: 'e4' },
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
      await user.click(screen.getByTestId('fire-square-e4'));
      // Дождаться загрузки drill #2.
      await waitFor(() => expect(loadDrill).toHaveBeenCalledTimes(2));
      // Запомним FEN живого drill'а #2 (другой, чем у #1).
      const liveBoardFen = screen
        .getByTestId('mock-board')
        .getAttribute('data-position');
      expect(liveBoardFen).toBe('8/8/8/8/8/8/8/8 w - - 0 1');

      // «Назад» → видим drill #1 + feedback (correct, e4).
      await user.click(screen.getByTestId('drill-runner-back'));
      expect(screen.getByTestId('mock-board').getAttribute('data-position')).toBe(
        SQUARE_DRILL.fen,
      );
      expect(
        screen.getByTestId('drill-runner').getAttribute('data-state'),
      ).toBe('feedback');
      expect(
        screen.getByTestId('drill-feedback').getAttribute('data-result'),
      ).toBe('correct');
    });

    it('«Назад» в feedback не триггерит auto-next (мы не на хвосте)', async () => {
      disableReducedMotion();
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
          autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={60_000}
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
      // На хвосте → 1 drill в истории. «Назад» disabled (history.length=1, idx=0).
      expect(screen.getByTestId('drill-runner-back')).toBeDisabled();
      // Дождёмся drill #2 через auto-next (delay=60s, но мы триггернём вручную? нет, он delay'ится — поэтому форсим).
      // Проверим вместо этого: после ручного «Вперёд» (есть feedback) грузим следующий.
      expect(screen.getByTestId('drill-runner-forward')).not.toBeDisabled();
      await user.click(screen.getByTestId('drill-runner-forward'));
      await waitFor(() => expect(loadDrill).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      // Теперь возвращаемся назад — drill #1 в feedback. Auto-next не должен
      // сработать (мы не на хвосте), state остаётся feedback после паузы.
      await user.click(screen.getByTestId('drill-runner-back'));
      expect(
        screen.getByTestId('drill-runner').getAttribute('data-state'),
      ).toBe('feedback');
      expect(
        screen.getByTestId('drill-runner').getAttribute('data-viewing-history'),
      ).toBe('true');
      // Подождём заметно дольше, чем 0мс — но меньше autoNextDelay'я. Состояние не должно уйти.
      await new Promise((r) => setTimeout(r, 150));
      expect(
        screen.getByTestId('drill-runner').getAttribute('data-state'),
      ).toBe('feedback');
      // loadDrill всё ещё 2 (новый не запрошен).
      expect(loadDrill).toHaveBeenCalledTimes(2);
    });

    it('повторный submit на исторический drill не отправляется в API (idempotent)', async () => {
      disableReducedMotion();
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
          autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={60_000}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'idle',
        ),
      );
      // Отвечаем на drill #1 → feedback.
      await user.click(screen.getByTestId('fire-square-e4'));
      await waitFor(() =>
        expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
          'feedback',
        ),
      );
      // Идём вперёд → drill #2 (idle).
      await user.click(screen.getByTestId('drill-runner-forward'));
      await waitFor(() => expect(loadDrill).toHaveBeenCalledTimes(2));
      // Возвращаемся к drill #1 (исторический, в feedback).
      await user.click(screen.getByTestId('drill-runner-back'));
      const submitsBefore = submitAnswer.mock.calls.length;
      // Пытаемся «ответить» снова — клик игнорируется submit'ом, т.к. state=feedback.
      await user.click(screen.getByTestId('fire-square-d4'));
      // submitAnswer не вызывается повторно для drill #1.
      expect(submitAnswer.mock.calls.length).toBe(submitsBefore);
    });

    it('«Вперёд» с исторической позиции возвращает к актуальному drill\'у (не запрашивает новый)', async () => {
      const loadDrill = vi
        .fn()
        .mockResolvedValueOnce(SQUARE_DRILL)
        .mockResolvedValueOnce({ ...SQUARE_DRILL, id: 'd-sq-2', fen: 'TAIL' });
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'square', square: 'e4' },
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
      await user.click(screen.getByTestId('fire-square-e4'));
      await waitFor(() => expect(loadDrill).toHaveBeenCalledTimes(2));
      // Уходим назад на drill #1.
      await user.click(screen.getByTestId('drill-runner-back'));
      expect(
        screen.getByTestId('drill-runner').getAttribute('data-history-index'),
      ).toBe('0');
      // «Вперёд» → возвращаемся к хвосту, новый drill НЕ грузим.
      const callsBefore = loadDrill.mock.calls.length;
      await user.click(screen.getByTestId('drill-runner-forward'));
      expect(loadDrill).toHaveBeenCalledTimes(callsBefore);
      expect(screen.getByTestId('mock-board').getAttribute('data-position')).toBe(
        'TAIL',
      );
    });

    it('история ограничена 10 элементами — старые вытесняются (FIFO)', async () => {
      // Готовим 12 разных drill'ов.
      const loadDrill = vi.fn();
      for (let i = 0; i < 12; i += 1) {
        loadDrill.mockResolvedValueOnce({ ...SQUARE_DRILL, id: `d-${i}` });
      }
      const submitAnswer = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'square', square: 'e4' },
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
      // Отвечаем 11 раз → 12 drill'ов попало в историю, должно остаться 10.
      for (let i = 0; i < 11; i += 1) {
        await user.click(screen.getByTestId('fire-square-e4'));
        await waitFor(() => expect(loadDrill).toHaveBeenCalledTimes(i + 2));
      }
      await waitFor(() =>
        expect(
          screen.getByTestId('drill-runner').getAttribute('data-history-size'),
        ).toBe('10'),
      );
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
