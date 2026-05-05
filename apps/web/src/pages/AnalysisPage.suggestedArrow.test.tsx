import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, act } from '@testing-library/react';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { AnalysisPage } from './AnalysisPage';

// --- Mocks copied from AnalysisPage.test.tsx, plus useArchiveTree and a
// Chessboard mock that exposes the arrows count via data attribute. ---

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

vi.mock('../hooks/useStockfish', () => ({
  useStockfish: () => ({
    state: 'ready',
    lines: [],
    bestMove: null,
    evaluate: vi.fn(),
    stop: vi.fn(),
    init: vi.fn(),
    isReady: true,
  }),
}));

vi.mock('../hooks/useEngine', () => ({
  useEngine: () => ({
    state: 'ready',
    lines: [],
    analysisFen: null,
    bestMove: null,
    evaluate: vi.fn(),
    stop: vi.fn(),
    setOption: vi.fn(),
    init: vi.fn(),
    cleanup: vi.fn(),
    isReady: true,
    engineName: 'Stockfish 18 (WASM)',
    engineSource: 'wasm' as const,
    errorMessage: null,
  }),
  loadEngineConfigs: () => [],
  saveEngineConfigs: vi.fn(),
}));

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

vi.mock('../hooks/useSavedAnalyses', () => ({
  useSavedAnalyses: () => ({
    create: vi.fn().mockResolvedValue({ id: 'saved-1' }),
    update: vi.fn().mockResolvedValue({ id: 'saved-1' }),
    getById: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
  }),
  getDefaultTitle: () => 'Untitled Analysis',
  parsePgnHeaders: () => ({}),
}));

// useArchiveTree mock — отдаём один ход, чтобы строка появилась в дереве
// и можно было сэмулировать hover.
vi.mock('../hooks/useArchiveTree', () => ({
  useArchiveTree: () => ({
    data: {
      totalGames: 100,
      moves: [
        {
          uci: 'e2e4',
          san: 'e4',
          total: 100,
          whitePct: 50,
          drawPct: 30,
          blackPct: 20,
          avgElo: 2400,
          lastSeenAt: '2024-01-01',
        },
      ],
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// Chessboard mock, который читает options.arrows и кладёт количество в DOM.
vi.mock('react-chessboard', () => ({
  Chessboard: (props: { options?: { arrows?: unknown[] } }) => (
    <div
      data-testid="chessboard"
      data-arrows-count={props.options?.arrows?.length ?? 0}
    />
  ),
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

describe('KS-2215: AnalysisPage — suggested arrow clears on position change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hover на строке дерева рисует стрелку, навигация по ходам её сбрасывает', async () => {
    renderWithProviders(<AnalysisPage />, { route: '/review/game-1' });

    // Дождёмся появления панели архива (тут наш единственный ход).
    const row = await screen.findByTestId('archive-tree-row-e2e4');
    const board = screen.getAllByTestId('chessboard')[0];

    // На старте стрелок нет.
    expect(board.getAttribute('data-arrows-count')).toBe('0');

    // Hover на строке дерева → suggestedArrow ставится → arrows.length=1.
    fireEvent.mouseEnter(row);
    await waitFor(() => {
      expect(
        screen.getAllByTestId('chessboard')[0].getAttribute('data-arrows-count'),
      ).toBe('1');
    });

    // Симулируем смену позиции на доске стрелкой клавиатуры (без mouseLeave —
    // это и есть сценарий touch-устройства, где mouseLeave после tap не
    // приходит). После загрузки партии указатель стоит на последнем ходе,
    // поэтому идём назад. useEffect в AnalysisPage обязан сбросить
    // suggested arrow при смене currentFen.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });

    await waitFor(() => {
      expect(
        screen.getAllByTestId('chessboard')[0].getAttribute('data-arrows-count'),
      ).toBe('0');
    });
  });
});
