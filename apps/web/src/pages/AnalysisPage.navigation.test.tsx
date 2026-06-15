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

vi.mock('../hooks/useStockfish', () => ({
  useStockfish: () => ({
    state: 'ready',
    lines: [],
    bestMove: null,
    evaluate: mockEvaluate,
    stop: mockStop,
    init: mockInit,
    isReady: true,
  }),
}));

vi.mock('../hooks/useEngine', () => ({
  useEngine: () => ({
    state: 'ready',
    lines: [],
    analysisFen: null,
    bestMove: null,
    evaluate: mockEvaluate,
    stop: mockStop,
    setOption: vi.fn(),
    init: mockInit,
    cleanup: vi.fn(),
    isReady: true,
    engineName: 'Stockfish 18 (WASM)',
    engineSource: 'wasm' as const,
    errorMessage: null,
  }),
  loadEngineConfigs: () => [],
  saveEngineConfigs: vi.fn(),
}));

// Stable function identities inside the factory (see comment in
// AnalysisPage.test.tsx) — prevents an infinite render loop when deps arrays
// in AnalysisPage reference these callbacks.
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
    // KS-4179: см. AnalysisPage.test.tsx — autosave-эффект теперь зовёт
    // put/post/patch/delete, токен в setup установлен по умолчанию.
    put: vi.fn(() => Promise.resolve({})),
    post: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(() => Promise.resolve({})),
  },
}));

let mockParams: Record<string, string> = { gameId: 'game-1' };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => mockParams,
  };
});

// --- Tests ---

describe('KS-311: Верификация навигации по ходам на странице анализа', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // AnalysisPage gates the `evaluate()` useEffect behind `analysisEnabled`,
    // whose initial value reads `localStorage.analysisRunning === 'true'`.
    // Without this, navigation keys re-compute `currentFen` but the engine
    // evaluator never fires, so `mockEvaluate` assertions never pass.
    localStorage.setItem('analysisRunning', 'true');
    mockParams = { gameId: 'game-1' };
  });

  /**
   * Сценарий 1: Страница анализа загружается через маршрут /analysis/:id
   */
  it('загружает данные игры при параметре gameId', async () => {
    mockParams = { gameId: 'game-1' };

    renderWithProviders(<AnalysisPage />, { route: '/analysis/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });
    expect(screen.getAllByText('BlackPlayer')[0]).toBeInTheDocument();
  });

  /**
   * Сценарий 3: Страница анализа загружается через параметр gameId (fallback)
   */
  it('загружает данные игры при параметре gameId (альтернативный формат)', async () => {
    mockParams = { gameId: 'game-1' };

    renderWithProviders(<AnalysisPage />, { route: '/analysis/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });
    expect(screen.getAllByText('BlackPlayer')[0]).toBeInTheDocument();
  });

  /**
   * Сценарий 2: Навигация вперёд по ходам
   */
  it('навигация вперёд клавишей ArrowRight переключает ходы', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/analysis/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    // После загрузки currentMoveIndex = moves.length - 1 (последний ход)
    // Переходим в начало, потом вперёд
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    });

    mockEvaluate.mockClear();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });

    await waitFor(() => {
      expect(mockEvaluate).toHaveBeenCalled();
    });
  });

  /**
   * Сценарий 2: Навигация назад по ходам
   */
  it('навигация назад клавишей ArrowLeft переключает ходы', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/analysis/game-1' });

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
   * Сценарий 4: Клавиша Home — переход в начало партии
   */
  it('клавиша Home переводит на начальную позицию', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/analysis/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    mockEvaluate.mockClear();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    });

    await waitFor(() => {
      expect(mockEvaluate).toHaveBeenCalled();
    });

    // Кнопка "назад" должна быть заблокирована на начальной позиции
    expect(screen.getByTitle('Previous move')).toBeDisabled();
    expect(screen.getByTitle('Go to start')).toBeDisabled();
  });

  /**
   * Сценарий 4: Клавиша End — переход в конец партии
   */
  it('клавиша End переводит на последний ход', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/analysis/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    // Сначала в начало
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    });

    // Потом в конец
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    });

    // Кнопки "вперёд" должны быть заблокированы на последнем ходу
    await waitFor(() => {
      expect(screen.getByTitle('Next move')).toBeDisabled();
      expect(screen.getByTitle('Go to end')).toBeDisabled();
    });
  });

  /**
   * Сценарий 5: Крайний случай — ArrowLeft на начальной позиции не ломается
   */
  it('ArrowLeft на начальной позиции не вызывает ошибку', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/analysis/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    // Переходим в начало
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    });

    // Пытаемся пойти ещё назад — не должно быть ошибки
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });

    expect(screen.getByTitle('Go to start')).toBeDisabled();
  });

  /**
   * Сценарий 5: Крайний случай — ArrowRight на последнем ходу не ломается
   */
  it('ArrowRight на последнем ходу не вызывает ошибку', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/analysis/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    // Пытаемся пойти вперёд за последний ход
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });

    expect(screen.getByTitle('Go to end')).toBeDisabled();
  });

  /**
   * Сценарий 2: Кнопки навигации работают
   */
  it('кнопка "Go to start" блокирует навигацию назад', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/analysis/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });

    act(() => {
      screen.getByTitle('Go to start').click();
    });

    expect(screen.getByTitle('Go to start')).toBeDisabled();
    expect(screen.getByTitle('Previous move')).toBeDisabled();
    expect(screen.getByTitle('Next move')).not.toBeDisabled();
    expect(screen.getByTitle('Go to end')).not.toBeDisabled();
  });

  /**
   * Параметр id приоритетнее gameId (проверка fallback-логики)
   */
  it('параметр gameId загружает данные игры', async () => {
    mockParams = { gameId: 'game-1' };

    renderWithProviders(<AnalysisPage />, { route: '/analysis/game-1' });

    await waitFor(() => {
      expect(screen.getAllByText('WhitePlayer')[0]).toBeInTheDocument();
    });
  });
});
