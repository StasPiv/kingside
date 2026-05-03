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
    const SQUARES = ['e4', 'e5', 'd4'];
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
    // В feedback кликаем Next — он триггерит finish (count достигнут).
    await user.click(screen.getByTestId('drill-runner-next'));
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
    await user.click(screen.getByTestId('drill-runner-next'));
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
    await user.click(screen.getByTestId('drill-runner-next'));
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
    await user.click(screen.getByTestId('drill-runner-next'));
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('fire-square-d4'));
    await user.click(screen.getByTestId('drill-runner-next'));
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
    await user.click(screen.getByTestId('drill-runner-next'));
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
