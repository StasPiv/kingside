import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { renderWithProviders, screen } from '../../../test/test-utils';

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../../api', () => ({
  api: {
    get: (path: string) => apiGet(path),
    post: (path: string, body: unknown) => apiPost(path, body),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}));

vi.mock('../../MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: {
      position?: string;
      onSquareClick?: (a: { piece: unknown; square: string }) => void;
      squareStyles?: Record<string, CSSProperties>;
    };
  }) => {
    const SQUARES = ['e4', 'd4'];
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

import { DrillStep } from './DrillStep';

const SQUARE_DRILL = {
  id: 'd-pin-1',
  drillType: 'find-pin',
  fen: '8/8/8/8/4P3/8/8/8 w - - 0 1',
  sideToMove: 'w',
  answerShape: 'square',
  difficulty: 2,
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

afterEach(() => vi.restoreAllMocks());

function byStepResp(drill = SQUARE_DRILL, count = 1, minSolved = 1) {
  return {
    drill,
    stepMeta: { stepId: 'step-1', count, minSolved },
  };
}

describe('<DrillStep> KS-2249', () => {
  it('mount со stepId → GET /tactic-drill/by-step/step-1 (KS-2315 резолвер)', async () => {
    apiGet.mockResolvedValue(byStepResp());
    renderWithProviders(
      <DrillStep
        payload={{ type: 'drill', drillType: 'find-pin' }}
        stepId="step-1"
      />,
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(apiGet).toHaveBeenCalledWith('/tactic-drill/by-step/step-1');
  });

  it('mount БЕЗ stepId → fallback на /tactic-drill/next?type=… (preview-сценарий)', async () => {
    apiGet.mockResolvedValue(SQUARE_DRILL);
    renderWithProviders(
      <DrillStep payload={{ type: 'drill', drillType: 'find-pin' }} />,
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(apiGet).toHaveBeenCalledWith('/tactic-drill/next?type=find-pin');
  });

  it('default count=1, minSolved=1: правильный ответ → onStepDone вызван', async () => {
    apiGet.mockResolvedValue(byStepResp());
    apiPost.mockResolvedValue({
      attemptId: 'a1',
      solved: true,
      correctAnswer: { shape: 'square', square: 'e4' },
    });
    const onStepDone = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillStep
        payload={{ type: 'drill', drillType: 'find-pin' }}
        stepId="step-1"
        onStepDone={onStepDone}
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
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'done',
      ),
    );
    expect(onStepDone).toHaveBeenCalledTimes(1);
    // POST /attempt c mode='lessons-embed'.
    expect(apiPost).toHaveBeenCalledWith(
      '/tactic-drill/attempt',
      expect.objectContaining({ mode: 'lessons-embed' }),
    );
  });

  it('count=1: неправильный ответ → done success=false, onStepDone НЕ вызван', async () => {
    apiGet.mockResolvedValue(byStepResp());
    apiPost.mockResolvedValue({
      attemptId: 'a1',
      solved: false,
      correctAnswer: { shape: 'square', square: 'e4' },
    });
    const onStepDone = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillStep
        payload={{ type: 'drill', drillType: 'find-pin' }}
        stepId="step-1"
        onStepDone={onStepDone}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('drill-runner').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
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
    expect(onStepDone).not.toHaveBeenCalled();
    // Retry-кнопка от DrillRunner.
    expect(screen.getByTestId('drill-runner-retry')).toBeInTheDocument();
  });

  it('payload.count=3 + minSolved=2: data-count/data-min-solved прокинуты в drill-step', async () => {
    apiGet.mockResolvedValue(byStepResp(SQUARE_DRILL, 3, 2));
    renderWithProviders(
      <DrillStep
        payload={{
          type: 'drill',
          drillType: 'find-pin',
          count: 3,
          minSolved: 2,
        }}
        stepId="step-x"
      />,
    );
    const root = screen.getByTestId('drill-step');
    expect(root.getAttribute('data-count')).toBe('3');
    expect(root.getAttribute('data-min-solved')).toBe('2');
    expect(root.getAttribute('data-step-id')).toBe('step-x');
  });

  it('drill-step имеет data-drill-type из payload', async () => {
    apiGet.mockResolvedValue(byStepResp());
    renderWithProviders(
      <DrillStep
        payload={{ type: 'drill', drillType: 'find-fork' }}
        stepId="s"
      />,
    );
    expect(screen.getByTestId('drill-step').getAttribute('data-drill-type')).toBe(
      'find-fork',
    );
  });
});
