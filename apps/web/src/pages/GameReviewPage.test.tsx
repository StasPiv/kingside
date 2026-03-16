import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { GameReviewPage } from './GameReviewPage';
import { act } from '@testing-library/react';

// --- Mocks ---

const mockEvaluate = vi.fn();
const mockStop = vi.fn();
const mockInit = vi.fn();

let stockfishState: string = 'ready';
let stockfishLines: Array<{
  depth: number;
  multipv: number;
  score: { type: 'cp' | 'mate'; value: number };
  pv: string;
  nodes?: number;
  nps?: number;
}> = [];

vi.mock('../hooks/useStockfish', () => ({
  useStockfish: (opts: { depth?: number; multiPv?: number }) => {
    // Verify requested depth and multiPv
    expect(opts.depth).toBe(18);
    expect(opts.multiPv).toBe(3);
    return {
      state: stockfishState,
      lines: stockfishLines,
      bestMove: null,
      evaluate: mockEvaluate,
      stop: mockStop,
      init: mockInit,
      isReady: stockfishState === 'ready' || stockfishState === 'analyzing',
    };
  },
}));

vi.mock('../hooks/useContainerSize', () => ({
  useContainerSize: () => ({ width: 400, height: 400 }),
}));

vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard" />,
}));

const mockGameData = {
  id: 'game-1',
  white: { id: 'w1', username: 'WhitePlayer' },
  black: { id: 'b1', username: 'BlackPlayer' },
  result: 'white',
  timeControl: '10+0',
  status: 'completed',
};

const mockMoves = [
  { san: 'e4', uci: 'e2e4', fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
  { san: 'e5', uci: 'e7e5', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' },
  { san: 'Nf3', uci: 'g1f3', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
  { san: 'Nc6', uci: 'b8c6', fenAfter: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3' },
];

vi.mock('../api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url.endsWith('/moves')) return Promise.resolve(mockMoves);
      return Promise.resolve(mockGameData);
    }),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ gameId: 'game-1' }),
  };
});

// --- Tests ---

describe('KS-308: GameReviewPage — Stockfish analysis verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stockfishState = 'ready';
    stockfishLines = [];
  });

  /**
   * Сценарий 6: Страница GameReviewPage загружается без ошибок
   */
  it('загружается и отображает данные игры', async () => {
    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    expect(screen.getAllByText('BlackPlayer')[0]).toBeInTheDocument();
    expect(screen.getByTestId('chessboard')).toBeInTheDocument();
  });

  /**
   * Сценарий 1: Eval bar отображается корректно
   */
  it('eval bar отображается с дефолтным значением 0.0 без линий', async () => {
    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    expect(screen.getByText('0.0')).toBeInTheDocument();
  });

  /**
   * Сценарий 1: Eval bar обновляется при наличии линий анализа
   */
  it('eval bar отображает оценку из первой линии', async () => {
    stockfishState = 'analyzing';
    stockfishLines = [
      { depth: 18, multipv: 1, score: { type: 'cp', value: 50 }, pv: 'e2e4 e7e5' },
      { depth: 18, multipv: 2, score: { type: 'cp', value: 200 }, pv: 'd2d4 d7d5' },
      { depth: 18, multipv: 3, score: { type: 'cp', value: 100 }, pv: 'g1f3 d7d5' },
    ];

    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      // +0.50 appears in eval-bar-label and line span (formatEval uses toFixed(2))
      expect(screen.getAllByText('+0.50').length).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * Сценарий 2: Отображаются 3 лучшие линии (multiPV) с глубиной 18
   */
  it('отображает 3 линии анализа с глубиной', async () => {
    stockfishState = 'analyzing';
    stockfishLines = [
      { depth: 18, multipv: 1, score: { type: 'cp', value: 50 }, pv: 'e2e4 e7e5' },
      { depth: 18, multipv: 2, score: { type: 'cp', value: 200 }, pv: 'd2d4 d7d5' },
      { depth: 18, multipv: 3, score: { type: 'cp', value: 100 }, pv: 'g1f3 d7d5' },
    ];

    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('+0.50').length).toBeGreaterThanOrEqual(1);
    });

    // Все 3 линии отображаются с уникальными оценками (toFixed(2))
    expect(screen.getByText('+2.00')).toBeInTheDocument();
    expect(screen.getByText('+1.00')).toBeInTheDocument();

    // Глубина отображается в progress
    expect(screen.getByText(/Depth 18/)).toBeInTheDocument();
  });

  /**
   * Сценарий 1: Мат отображается корректно
   */
  it('eval bar отображает мат корректно', async () => {
    stockfishState = 'analyzing';
    stockfishLines = [
      { depth: 18, multipv: 1, score: { type: 'mate', value: 3 }, pv: 'e2e4' },
      { depth: 18, multipv: 2, score: { type: 'cp', value: 100 }, pv: 'd2d4' },
      { depth: 18, multipv: 3, score: { type: 'cp', value: 50 }, pv: 'g1f3' },
    ];

    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      // M3 appears in eval-bar-label and line span
      expect(screen.getAllByText('M3').length).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * Сценарий 1: Мат в 0 отображается как #
   */
  it('мат в 0 отображается как #', async () => {
    stockfishState = 'analyzing';
    stockfishLines = [
      { depth: 18, multipv: 1, score: { type: 'mate', value: 0 }, pv: '' },
      { depth: 18, multipv: 2, score: { type: 'cp', value: 100 }, pv: 'd2d4' },
      { depth: 18, multipv: 3, score: { type: 'cp', value: 50 }, pv: 'g1f3' },
    ];

    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('#').length).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * Сценарий 3: Автоматический анализ запускается при переходе между ходами
   */
  it('evaluate вызывается при загрузке страницы', async () => {
    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(mockEvaluate).toHaveBeenCalled();
    });
  });

  /**
   * Сценарий 3: Evaluate вызывается при навигации клавишами
   */
  it('evaluate перезапускается при навигации по ходам', async () => {
    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    mockEvaluate.mockClear();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });

    await waitFor(() => {
      expect(mockEvaluate).toHaveBeenCalled();
    });
  });

  /**
   * Сценарий 6: Список ходов отображается корректно
   */
  it('список ходов отображается с номерами', async () => {
    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('1.e4').length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getAllByText('e5').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('2.Nf3').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Nc6').length).toBeGreaterThanOrEqual(1);
  });

  /**
   * Сценарий 7: Навигация кнопками работает
   */
  it('кнопки навигации присутствуют', async () => {
    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    expect(screen.getByTitle('Go to start')).toBeInTheDocument();
    expect(screen.getByTitle('Previous move')).toBeInTheDocument();
    expect(screen.getByTitle('Next move')).toBeInTheDocument();
    expect(screen.getByTitle('Go to end')).toBeInTheDocument();
  });

  /**
   * Сценарий 1: Eval bar — отрицательная оценка
   */
  it('eval bar отображает отрицательную оценку', async () => {
    stockfishState = 'analyzing';
    stockfishLines = [
      { depth: 18, multipv: 1, score: { type: 'cp', value: -150 }, pv: 'e2e4' },
      { depth: 18, multipv: 2, score: { type: 'cp', value: -100 }, pv: 'd2d4' },
      { depth: 18, multipv: 3, score: { type: 'cp', value: -50 }, pv: 'g1f3' },
    ];

    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('-1.50').length).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * Сценарий 1: Eval bar — мат для черных
   */
  it('eval bar при мате для черных отображает M с абсолютным значением', async () => {
    stockfishState = 'analyzing';
    stockfishLines = [
      { depth: 18, multipv: 1, score: { type: 'mate', value: -2 }, pv: 'e2e4' },
      { depth: 18, multipv: 2, score: { type: 'cp', value: -100 }, pv: 'd2d4' },
      { depth: 18, multipv: 3, score: { type: 'cp', value: -50 }, pv: 'g1f3' },
    ];

    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('M2').length).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * Stockfish 18 label отображается
   */
  it('Stockfish 18 label отображается', async () => {
    renderWithProviders(<GameReviewPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getByText(/Stockfish 18/)).toBeInTheDocument();
    });
  });
});
