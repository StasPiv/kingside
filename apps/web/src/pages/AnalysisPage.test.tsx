import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { AnalysisPage } from './AnalysisPage';
import { act } from '@testing-library/react';

// --- Mocks ---

// AnalysisPage reads `useAuth()` at render time; the test harness does not
// mount AuthProvider, so provide a stub that returns an unauthenticated user.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    token: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

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
  useStockfish: () => ({
    state: stockfishState,
    lines: stockfishLines,
    bestMove: null,
    evaluate: mockEvaluate,
    stop: mockStop,
    init: mockInit,
    isReady: stockfishState === 'ready' || stockfishState === 'analyzing',
  }),
}));

vi.mock('../hooks/useEngine', () => ({
  useEngine: () => ({
    state: stockfishState,
    lines: stockfishLines,
    analysisFen: null,
    bestMove: null,
    evaluate: mockEvaluate,
    stop: mockStop,
    setOption: vi.fn(),
    init: mockInit,
    cleanup: vi.fn(),
    isReady: stockfishState === 'ready' || stockfishState === 'analyzing',
    engineName: 'Stockfish 18 (WASM)',
    engineSource: 'wasm' as const,
    errorMessage: null,
  }),
  loadEngineConfigs: () => [],
  saveEngineConfigs: vi.fn(),
}));

// Instantiate stable vi.fn() refs once inside the factory. Creating them per
// call would mean every render of AnalysisPage sees new identity for these
// functions; any hook that has them in a deps array would re-run, and the
// persistence `useEffect` for the saved-analysis auto-save triggers setState,
// producing an infinite render loop ("Maximum update depth exceeded").
vi.mock('../hooks/useEngineConfig', () => {
  const config = {
    engineSource: 'wasm' as const,
    setEngineSource: vi.fn(),
    externalConfig: null,
    setExternalConfig: vi.fn(),
    savedConfigs: [],
    showEngineSettings: false,
    setShowEngineSettings: vi.fn(),
    extUrlInput: '',
    setExtUrlInput: vi.fn(),
    extKeyInput: '',
    setExtKeyInput: vi.fn(),
    extNameInput: '',
    setExtNameInput: vi.fn(),
    uciThreads: '1',
    setUciThreads: vi.fn(),
    uciHash: '256',
    setUciHash: vi.fn(),
    multiPv: 3,
    setMultiPv: vi.fn(),
    showEngineModal: false,
    setShowEngineModal: vi.fn(),
    handleConnectExternal: vi.fn(),
    handleDeleteConfig: vi.fn(),
    handleSelectSavedConfig: vi.fn(),
    handleSwitchToWasm: vi.fn(),
  };
  return { useEngineConfig: () => config };
});

vi.mock('../hooks/useContainerSize', () => ({
  useContainerSize: () => ({ width: 400, height: 400 }),
}));

// KS-2434: серверный анализ партии удалён, мок не нужен.

vi.mock('../hooks/useSavedAnalyses', () => {
  const api = {
    create: vi.fn().mockResolvedValue({ id: 'saved-1' }),
    update: vi.fn().mockResolvedValue({ id: 'saved-1' }),
    getById: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return {
    useSavedAnalyses: () => api,
    getDefaultTitle: () => 'Untitled Analysis',
    parsePgnHeaders: () => ({}),
  };
});

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

describe('KS-308: AnalysisPage — Stockfish analysis verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // AnalysisPage gates the `evaluate()` useEffect behind `analysisEnabled`,
    // whose initial value reads `localStorage.analysisRunning === 'true'`.
    // Without this the auto-analysis never fires and evaluate assertions hang.
    localStorage.setItem('analysisRunning', 'true');
    stockfishState = 'ready';
    stockfishLines = [];
  });

  /**
   * Сценарий 6: Страница AnalysisPage загружается без ошибок
   */
  it('загружается и отображает данные игры', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

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
    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

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

    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

    await waitFor(() => {
      // +0.50 appears in eval-bar-label and line span (formatEval uses toFixed(2))
      expect(screen.getAllByText('+0.50').length).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * Сценарий 2: Отображаются 3 лучшие линии (multiPV)
   *
   * NOTE: the standalone "Depth N" progress indicator was removed from the
   * engine panel; depth is now only embedded within each line's formatted PV
   * (not as a distinct label), so we no longer assert on it.
   */
  it('отображает 3 линии анализа с глубиной', async () => {
    stockfishState = 'analyzing';
    stockfishLines = [
      { depth: 18, multipv: 1, score: { type: 'cp', value: 50 }, pv: 'e2e4 e7e5' },
      { depth: 18, multipv: 2, score: { type: 'cp', value: 200 }, pv: 'd2d4 d7d5' },
      { depth: 18, multipv: 3, score: { type: 'cp', value: 100 }, pv: 'g1f3 d7d5' },
    ];

    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('+0.50').length).toBeGreaterThanOrEqual(1);
    });

    // The top line eval (+0.50) also shows in the eval bar, so the other two
    // lines (+2.00, +1.00) can legitimately appear once (in .stockfish-line)
    // or more (if also surfaced in other panels). Use `getAllByText` to tolerate
    // either.
    expect(screen.getAllByText('+2.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('+1.00').length).toBeGreaterThanOrEqual(1);

    // AnalysisPage duplicates the engine panel (one for desktop layout, one
    // for the mobile tab), so each of the 3 lines renders twice. Assert that
    // both panels consistently contain all 3 lines.
    const lineEls = document.querySelectorAll('.stockfish-line');
    expect(lineEls.length).toBe(6);
    expect(document.querySelectorAll('.stockfish-lines').length).toBe(2);
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

    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

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

    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('#').length).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * Сценарий 3: Автоматический анализ запускается при переходе между ходами
   */
  it('evaluate вызывается при загрузке страницы', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(mockEvaluate).toHaveBeenCalled();
    });
  });

  /**
   * Сценарий 3: Evaluate вызывается при навигации клавишами
   */
  it('evaluate перезапускается при навигации по ходам', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

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
    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

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
    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

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

    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

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

    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('M2').length).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * Stockfish 18 label отображается
   */
  it('Stockfish 18 label отображается', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

    // На AnalysisPage заголовок «Stockfish 18 (WASM)» рендерится в двух
    // местах одновременно: desktop `.analysis-panel-title` и
    // mobile `[data-testid="analysis-mobile-engine-meta"]`. Используем
    // getAllByText вместо getByText (последний требует уникальности).
    await waitFor(() => {
      expect(screen.getAllByText(/Stockfish 18/).length).toBeGreaterThan(0);
    });
  });

  /**
   * KS-2220: кнопка «Copy PGN» рендерится рядом с «↓ PGN»
   * и при успешном `navigator.clipboard.writeText` показывает toast.
   */
  it('KS-2220: «Copy PGN» копирует PGN в буфер и показывает toast', async () => {
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
      });
    }
    const writeTextSpy = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined);

    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

    // Дожидаемся загрузки игры — moves подкачаются и кнопка станет enabled.
    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    // KS-2678: Copy PGN живёт только в overflow-меню — сначала открыть.
    const overflowBtn = await screen.findByTestId('analysis-overflow-btn');
    await act(async () => {
      overflowBtn.click();
    });
    const copyBtn = await screen.findByTestId('analysis-copy-pgn-overflow');

    await act(async () => {
      copyBtn.click();
    });

    await waitFor(() =>
      expect(screen.getByTestId('analysis-copy-pgn-msg')).toHaveTextContent(
        /copied/i,
      ),
    );
    expect(writeTextSpy).toHaveBeenCalled();
    // PGN должен содержать хотя бы один из ходов из mockMoves.
    const arg = writeTextSpy.mock.calls[0][0] as string;
    expect(arg).toMatch(/e4/);

    writeTextSpy.mockRestore();
  });

  /**
   * KS-2220: при reject от clipboard.writeText появляется toast-ошибка.
   */
  it('KS-2220: «Copy PGN» при reject clipboard показывает toast-ошибку', async () => {
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
      });
    }
    const writeTextSpy = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValue(new Error('permission denied'));

    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    // KS-2678: Copy PGN живёт только в overflow-меню — сначала открыть.
    const overflowBtn = await screen.findByTestId('analysis-overflow-btn');
    await act(async () => {
      overflowBtn.click();
    });
    const copyBtn = await screen.findByTestId('analysis-copy-pgn-overflow');

    await act(async () => {
      copyBtn.click();
    });

    await waitFor(() =>
      expect(screen.getByTestId('analysis-copy-pgn-msg')).toHaveTextContent(
        /failed/i,
      ),
    );

    writeTextSpy.mockRestore();
  });
});
