import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, screen } from '../test/test-utils';

// ── api mock ──────────────────────────────────────────────────────────
const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (path: string) => apiGet(path),
    post: (path: string, body: unknown) => apiPost(path, body),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}));

// ── MemoChessboard mock — выставляет fire-buttons под клетки и
//    показывает orientation/squareStyles в data-* для проверки.
vi.mock('../components/MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: {
      position?: string;
      boardOrientation?: 'white' | 'black';
      squareStyles?: Record<string, CSSProperties>;
      onSquareClick?: (args: { piece: unknown; square: string }) => void;
    };
  }) => {
    const SQUARES = ['e4', 'e5', 'd4', 'd5', 'c4', 'f6', 'g7', 'h2'];
    return (
      <div
        data-testid="mock-board"
        data-position={options.position ?? ''}
        data-orientation={options.boardOrientation ?? 'white'}
        data-highlighted={
          options.squareStyles
            ? Object.keys(options.squareStyles).join(',')
            : ''
        }
      >
        {SQUARES.map((sq) => (
          <button
            type="button"
            key={sq}
            data-testid={`fire-square-${sq}`}
            onClick={() =>
              options.onSquareClick?.({ piece: null, square: sq })
            }
          >
            {sq}
          </button>
        ))}
      </div>
    );
  },
}));

import { DrillPage } from './DrillPage';

/**
 * MemoryRouter из renderWithProviders не описывает route с :type
 * параметром, поэтому useParams вернёт {}. Оборачиваем DrillPage в
 * Routes с настоящим parameterised path, чтобы useParams отдавал
 * нужное значение.
 */
function renderDrillAt(type: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/drills/:type" element={<DrillPage />} />
      <Route path="/drills" element={<div data-testid="redirected-lobby" />} />
    </Routes>,
    { route: `/drills/${type}` },
  );
}

function makeDrill(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'drill-1',
    drillType: 'find-pin',
    fen: '8/8/8/8/4P3/8/8/8 w - - 0 1',
    sideToMove: 'w',
    answerShape: 'square',
    difficulty: 1,
    ...overrides,
  };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<DrillPage> KS-2233', () => {
  it('невалидный type → редирект (страница не рендерится)', async () => {
    apiGet.mockResolvedValue(makeDrill());
    renderDrillAt('totally-not-a-type');
    // Без валидного type useEffect редиректит — fetchNext не запускается.
    await waitFor(() => {
      expect(apiGet).not.toHaveBeenCalled();
    });
  });

  it('mount → loading-стейт, затем idle когда /next ответил', async () => {
    apiGet.mockResolvedValue(makeDrill({ drillType: 'find-pin' }));
    renderDrillAt('find-pin');
    // initial loading.
    expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
      'loading',
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('drill-page').getAttribute('data-state'),
      ).toBe('idle'),
    );
    expect(apiGet).toHaveBeenCalledWith('/tactic-drill/next?type=find-pin');
  });

  // ── shape='square' ───────────────────────────────────────────────
  it('shape=square: клик по клетке → POST /attempt с {shape:square,square}', async () => {
    apiGet.mockResolvedValue(
      makeDrill({ drillType: 'find-pin', answerShape: 'square' }),
    );
    apiPost.mockResolvedValue({
      attemptId: 'a1',
      solved: true,
      correctAnswer: { shape: 'square', square: 'e4' },
    });
    const user = userEvent.setup();
    renderDrillAt('find-pin');
    await waitFor(() =>
      expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('fire-square-e4'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/tactic-drill/attempt',
        expect.objectContaining({
          drillId: 'drill-1',
          mode: 'drill',
          userAnswer: { shape: 'square', square: 'e4' },
        }),
      ),
    );
  });

  it('shape=square: после правильного ответа → feedback success + Next-кнопка', async () => {
    apiGet.mockResolvedValueOnce(
      makeDrill({ drillType: 'find-pin', answerShape: 'square' }),
    );
    apiPost.mockResolvedValue({
      attemptId: 'a1',
      solved: true,
      correctAnswer: { shape: 'square', square: 'e4' },
    });
    const user = userEvent.setup();
    renderDrillAt('find-pin');
    await waitFor(() =>
      expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('fire-square-e4'));
    await waitFor(() =>
      expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
        'feedback',
      ),
    );
    expect(screen.getByTestId('drill-feedback').getAttribute('data-result')).toBe(
      'correct',
    );
    expect(screen.getByTestId('drill-page-next')).toBeInTheDocument();
    // progress: 1/1.
    const progress = screen.getByTestId('drill-page-progress');
    expect(progress.getAttribute('data-attempted')).toBe('1');
    expect(progress.getAttribute('data-solved')).toBe('1');
  });

  // ── shape='squares' ──────────────────────────────────────────────
  it('shape=squares: клики накапливаются (toggle), submit-кнопка отправляет массив', async () => {
    apiGet.mockResolvedValue(
      makeDrill({
        drillType: 'find-all-checks',
        answerShape: 'squares',
        meta: { expectedCount: 2 },
      }),
    );
    apiPost.mockResolvedValue({
      attemptId: 'a1',
      solved: true,
      correctAnswer: { shape: 'squares', squares: ['e4', 'e5'] },
      metrics: {
        truePositive: 2,
        falsePositive: 0,
        falseNegative: 0,
        iou: 1,
      },
    });
    const user = userEvent.setup();
    renderDrillAt('find-all-checks');
    await waitFor(() =>
      expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    // Submit изначально disabled (пусто).
    const submit = screen.getByTestId('drill-page-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // Клик по e4 → e5 → counter 2/2.
    await user.click(screen.getByTestId('fire-square-e4'));
    await user.click(screen.getByTestId('fire-square-e5'));
    expect(screen.getByTestId('drill-page-squares-counter').textContent).toContain(
      '2 / 2',
    );
    // toggle: re-click e5 → counter 1/2.
    await user.click(screen.getByTestId('fire-square-e5'));
    expect(screen.getByTestId('drill-page-squares-counter').textContent).toContain(
      '1 / 2',
    );
    // Финальный submit с [e4].
    await user.click(submit);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/tactic-drill/attempt',
        expect.objectContaining({
          userAnswer: { shape: 'squares', squares: ['e4'] },
        }),
      ),
    );
  });

  // ── shape='number' ───────────────────────────────────────────────
  it('shape=number: клик по кнопке "3" → POST {shape:number,value:3}', async () => {
    apiGet.mockResolvedValue(
      makeDrill({
        drillType: 'count-attackers',
        answerShape: 'number',
        meta: { highlightedSquare: 'e5' },
      }),
    );
    apiPost.mockResolvedValue({
      attemptId: 'a1',
      solved: false,
      correctAnswer: { shape: 'number', value: 2 },
    });
    const user = userEvent.setup();
    renderDrillAt('count-attackers');
    await waitFor(() =>
      expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    // Подсветка целевой клетки (e5).
    expect(screen.getByTestId('mock-board').getAttribute('data-highlighted')).toBe(
      'e5',
    );
    await user.click(screen.getByTestId('drill-count-attackers-btn-3'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/tactic-drill/attempt',
        expect.objectContaining({
          userAnswer: { shape: 'number', value: 3 },
        }),
      ),
    );
    // feedback: incorrect (solved=false).
    await waitFor(() =>
      expect(screen.getByTestId('drill-feedback').getAttribute('data-result')).toBe(
        'incorrect',
      ),
    );
    expect(screen.getByTestId('drill-page-progress').getAttribute('data-solved')).toBe(
      '0',
    );
    expect(screen.getByTestId('drill-page-progress').getAttribute('data-attempted')).toBe(
      '1',
    );
  });

  // ── shape='move' ─────────────────────────────────────────────────
  it('shape=move: первый клик = from, второй клик = to → POST {shape:move,from,to}', async () => {
    apiGet.mockResolvedValue(
      makeDrill({
        drillType: 'find-undefended-attack',
        answerShape: 'move',
      }),
    );
    apiPost.mockResolvedValue({
      attemptId: 'a1',
      solved: true,
      correctAnswer: { shape: 'move', from: 'e4', to: 'e5' },
    });
    const user = userEvent.setup();
    renderDrillAt('find-undefended-attack');
    await waitFor(() =>
      expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    // 1-й клик — from.
    await user.click(screen.getByTestId('fire-square-e4'));
    expect(screen.getByTestId('drill-page-move-hint').textContent).toContain(
      'e4',
    );
    // Подсветка from.
    expect(screen.getByTestId('mock-board').getAttribute('data-highlighted')).toBe(
      'e4',
    );
    // 2-й клик — to → submit.
    await user.click(screen.getByTestId('fire-square-e5'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/tactic-drill/attempt',
        expect.objectContaining({
          userAnswer: { shape: 'move', from: 'e4', to: 'e5' },
        }),
      ),
    );
  });

  it('shape=move: повторный клик по from-клетке снимает выбор', async () => {
    apiGet.mockResolvedValue(
      makeDrill({
        drillType: 'find-undefended-attack',
        answerShape: 'move',
      }),
    );
    const user = userEvent.setup();
    renderDrillAt('find-undefended-attack');
    await waitFor(() =>
      expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('fire-square-e4'));
    expect(screen.queryByTestId('drill-page-move-hint')).toBeInTheDocument();
    await user.click(screen.getByTestId('fire-square-e4'));
    expect(screen.queryByTestId('drill-page-move-hint')).not.toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  // ── feedback / next ──────────────────────────────────────────────
  it('после feedback клик "Next" → новый /next запрос, состояние возвращается в loading→idle', async () => {
    apiGet
      .mockResolvedValueOnce(makeDrill({ id: 'd1', drillType: 'find-pin' }))
      .mockResolvedValueOnce(makeDrill({ id: 'd2', drillType: 'find-pin' }));
    apiPost.mockResolvedValue({
      attemptId: 'a1',
      solved: true,
      correctAnswer: { shape: 'square', square: 'e4' },
    });
    const user = userEvent.setup();
    renderDrillAt('find-pin');
    await waitFor(() =>
      expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('fire-square-e4'));
    await waitFor(() =>
      expect(screen.getByTestId('drill-page-next')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('drill-page-next'));
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledTimes(2);
    });
  });

  // ── error states ─────────────────────────────────────────────────
  it('сетевая ошибка /next → error-state с retry-кнопкой', async () => {
    apiGet.mockRejectedValueOnce(new Error('500'));
    renderDrillAt('find-pin');
    await waitFor(() =>
      expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
        'error',
      ),
    );
    expect(screen.getByTestId('drill-page-retry')).toBeInTheDocument();
  });

  it('сетевая ошибка /attempt → error-state с retry-кнопкой', async () => {
    apiGet.mockResolvedValue(
      makeDrill({ drillType: 'find-pin', answerShape: 'square' }),
    );
    apiPost.mockRejectedValueOnce(new Error('500'));
    const user = userEvent.setup();
    renderDrillAt('find-pin');
    await waitFor(() =>
      expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
        'idle',
      ),
    );
    await user.click(screen.getByTestId('fire-square-e4'));
    await waitFor(() =>
      expect(screen.getByTestId('drill-page').getAttribute('data-state')).toBe(
        'error',
      ),
    );
    expect(screen.getByTestId('drill-page-retry')).toBeInTheDocument();
  });
});
