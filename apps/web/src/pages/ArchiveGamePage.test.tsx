import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { ArchiveGamePage } from './ArchiveGamePage';

/**
 * KS-2070 (F4): unit-тесты страницы одной архивной партии.
 *
 * Мокаем:
 *  - `archiveApi.getArchiveGameById` — для основного fetch'а партии.
 *  - `globalThis.fetch` — для lazy-блока «Other games with this position»
 *    (он ходит напрямую через fetch, паттерн `useArchiveGamesByPosition`).
 *  - `react-router-dom.useNavigate`/`useParams` — чтобы не оборачивать
 *    тест в полный router.
 */

const mockArchiveApi = {
  getArchiveGameById: vi.fn(),
};

vi.mock('../api/archive', () => ({
  archiveApi: {
    getArchiveGameById: (...args: unknown[]) =>
      mockArchiveApi.getArchiveGameById(...args),
  },
}));

const mockNavigate = vi.fn();
const mockUseParams = vi.fn(() => ({ id: 'g-1' }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => mockUseParams(),
  };
});

// react-chessboard в JSDOM падает «Square width not found» — у нас нет
// `getBoundingClientRect` с реальными размерами. Мокаем `MemoChessboard`
// под легковесный заглушочный <div>, у нас всё равно проверяется только
// data-fen, а не рендер фигур.
vi.mock('../components/MemoChessboard', () => ({
  MemoChessboard: ({ options }: { options: { position: string } }) => (
    <div data-testid="memo-chessboard-stub" data-fen={options.position} />
  ),
}));

const fetchMock = vi.fn();
const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

const baseGame = {
  id: 'g-1',
  white: { name: 'Magnus Carlsen', elo: 2870, title: 'GM' },
  black: { name: 'Hikaru Nakamura', elo: 2780, title: 'GM' },
  result: '1-0' as const,
  eco: 'C42',
  opening: 'Petroff Defense',
  event: 'World Cup',
  date: '2024.01.15',
  plyCount: 4,
  pgn: '1. e4 e5 2. Nf3 Nc6 *',
  site: null,
  round: '1',
};

beforeEach(() => {
  mockArchiveApi.getArchiveGameById.mockReset();
  mockNavigate.mockReset();
  mockUseParams.mockReset();
  mockUseParams.mockReturnValue({ id: 'g-1' });
  fetchMock.mockReset();
  // KS-2070: используем `vi.stubGlobal` (а не прямое присваивание
  // `globalThis.fetch = fetchMock`), чтобы `vi.unstubAllGlobals()` в
  // afterEach автоматически восстановил оригинальный fetch и не сломал
  // соседние тесты в общем прогоне.
  vi.stubGlobal('fetch', fetchMock);
  clipboardWriteText.mockReset();
  clipboardWriteText.mockResolvedValue(undefined);
  // happy-dom предоставляет `navigator.clipboard` как not-configurable
  // объект, поэтому `Object.defineProperty(navigator, 'clipboard', ...)`
  // не пробьёт. Подменяем сам метод `writeText` напрямую — это работает
  // в обоих окружениях (happy-dom и jsdom).
  if (!('clipboard' in navigator) || !navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWriteText },
      writable: true,
      configurable: true,
    });
  } else {
    (navigator.clipboard as { writeText: typeof clipboardWriteText }).writeText =
      clipboardWriteText;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ArchiveGamePage — загрузка', () => {
  it('рендерит партию: имена, результат, доску, ходы', async () => {
    mockArchiveApi.getArchiveGameById.mockResolvedValueOnce(baseGame);

    renderWithProviders(<ArchiveGamePage />);

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page')).toHaveAttribute(
        'data-state',
        'ready',
      ),
    );

    expect(mockArchiveApi.getArchiveGameById).toHaveBeenCalledWith('g-1');
    expect(screen.getByText('Magnus Carlsen')).toBeInTheDocument();
    expect(screen.getByText('Hikaru Nakamura')).toBeInTheDocument();
    expect(screen.getByTestId('archive-game-page-result')).toHaveTextContent(
      '1-0',
    );
    expect(screen.getByTestId('archive-game-page-board')).toBeInTheDocument();
    // 4 хода в PGN — должно быть 4 кнопки `archive-game-page-move-N`.
    expect(screen.getByTestId('archive-game-page-move-1')).toHaveTextContent(
      'e4',
    );
    expect(screen.getByTestId('archive-game-page-move-4')).toHaveTextContent(
      'Nc6',
    );
    expect(screen.getByTestId('archive-game-page-counter')).toHaveTextContent(
      '0/4',
    );
  });

  it('показывает «Game not found» при 404', async () => {
    mockArchiveApi.getArchiveGameById.mockRejectedValueOnce(
      new Error('Archive request failed: 404'),
    );

    renderWithProviders(<ArchiveGamePage />);

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page')).toHaveAttribute(
        'data-state',
        'not-found',
      ),
    );
    expect(
      screen.getByTestId('archive-game-page-back'),
    ).toHaveAttribute('href', '/archive');
  });

  it('показывает load_error при прочих ошибках', async () => {
    mockArchiveApi.getArchiveGameById.mockRejectedValueOnce(
      new Error('Network down'),
    );

    renderWithProviders(<ArchiveGamePage />);

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page')).toHaveAttribute(
        'data-state',
        'error',
      ),
    );
  });
});

describe('ArchiveGamePage — навигация по ходам', () => {
  it('клик «next» меняет ply и FEN доски', async () => {
    mockArchiveApi.getArchiveGameById.mockResolvedValueOnce(baseGame);
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveGamePage />);

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page-counter')).toHaveTextContent(
        '0/4',
      ),
    );
    const board = screen.getByTestId('archive-game-page-board');
    const startFen = board.getAttribute('data-fen');

    await user.click(screen.getByTestId('archive-game-page-next'));
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page-counter')).toHaveTextContent(
        '1/4',
      ),
    );
    expect(board.getAttribute('data-fen')).not.toBe(startFen);
  });

  it('клик по конкретному ходу переключает ply', async () => {
    mockArchiveApi.getArchiveGameById.mockResolvedValueOnce(baseGame);
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveGamePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page-counter')).toHaveTextContent(
        '0/4',
      ),
    );

    await user.click(screen.getByTestId('archive-game-page-move-3'));
    expect(screen.getByTestId('archive-game-page-counter')).toHaveTextContent(
      '3/4',
    );
  });
});

describe('ArchiveGamePage — кнопки действий', () => {
  it('«Open in analysis» зовёт navigate с правильным state', async () => {
    mockArchiveApi.getArchiveGameById.mockResolvedValueOnce(baseGame);
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveGamePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page')).toHaveAttribute(
        'data-state',
        'ready',
      ),
    );

    await user.click(screen.getByTestId('archive-game-page-open-in-analysis'));
    expect(mockNavigate).toHaveBeenCalledWith(
      '/analysis',
      expect.objectContaining({
        state: expect.objectContaining({
          pgn: baseGame.pgn,
          title: 'Magnus Carlsen vs Hikaru Nakamura',
          breadcrumbBackUrl: '/archive/games/g-1',
        }),
      }),
    );
  });

  it('«Find similar» зовёт navigate на /archive/games?fen=...', async () => {
    mockArchiveApi.getArchiveGameById.mockResolvedValueOnce(baseGame);
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveGamePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page')).toHaveAttribute(
        'data-state',
        'ready',
      ),
    );

    await user.click(screen.getByTestId('archive-game-page-find-similar'));
    const arg = mockNavigate.mock.calls[0][0] as string;
    expect(arg.startsWith('/archive/games?fen=')).toBe(true);
  });

  it('«Copy PGN» зовёт navigator.clipboard.writeText', async () => {
    mockArchiveApi.getArchiveGameById.mockResolvedValueOnce(baseGame);
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveGamePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page')).toHaveAttribute(
        'data-state',
        'ready',
      ),
    );

    await user.click(screen.getByTestId('archive-game-page-copy-pgn'));
    await waitFor(() =>
      expect(clipboardWriteText).toHaveBeenCalledWith(baseGame.pgn),
    );
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page-copy-msg')).toBeInTheDocument(),
    );
  });
});

describe('ArchiveGamePage — ссылки на профили игроков', () => {
  it('имена ведут на /archive/players/<slug>', async () => {
    mockArchiveApi.getArchiveGameById.mockResolvedValueOnce(baseGame);

    renderWithProviders(<ArchiveGamePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page')).toHaveAttribute(
        'data-state',
        'ready',
      ),
    );

    expect(screen.getByTestId('archive-game-page-white-link')).toHaveAttribute(
      'href',
      '/archive/players/magnus-carlsen',
    );
    expect(screen.getByTestId('archive-game-page-black-link')).toHaveAttribute(
      'href',
      '/archive/players/hikaru-nakamura',
    );
  });
});

describe('ArchiveGamePage — lazy-блок «Other games»', () => {
  function makeByPositionResp(items: unknown[]) {
    return {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          fen: 'somefen',
          positionKey: 'k',
          bucket: 'master',
          sort: 'topElo',
          items,
          nextCursor: null,
          hasMore: false,
          totalApprox: items.length,
        }),
    };
  }

  it('по умолчанию collapsed (fetch не вызывается)', async () => {
    mockArchiveApi.getArchiveGameById.mockResolvedValueOnce(baseGame);

    renderWithProviders(<ArchiveGamePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page')).toHaveAttribute(
        'data-state',
        'ready',
      ),
    );

    expect(screen.getByTestId('archive-other-games')).toHaveAttribute(
      'data-state',
      'closed',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('клик toggle — fetch + рендер 5 строк', async () => {
    mockArchiveApi.getArchiveGameById.mockResolvedValueOnce(baseGame);
    const fakeItems = Array.from({ length: 5 }, (_, i) => ({
      id: `o-${i}`,
      white: { name: `W${i}`, elo: 2500, title: null },
      black: { name: `B${i}`, elo: 2400, title: null },
      result: '1-0',
      eco: 'C42',
      opening: null,
      event: null,
      date: '2024.01.15',
      plyCount: 30,
      reachedAtPly: 0,
      nextMoveUci: null,
      sideToMove: 'w',
    }));
    fetchMock.mockResolvedValueOnce(makeByPositionResp(fakeItems));

    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveGamePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page')).toHaveAttribute(
        'data-state',
        'ready',
      ),
    );

    await user.click(screen.getByTestId('archive-other-games-toggle'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/\/games\/by-position\?/);
    expect(url).toMatch(/limit=5/);

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-o-0')).toBeInTheDocument(),
    );
    // «See all →» ведёт на /archive/games?fen=...
    const seeAll = screen.getByTestId('archive-other-games-see-all');
    expect(seeAll.getAttribute('href')).toMatch(/^\/archive\/games\?fen=/);
  });

  it('при смене ply блок сбрасывается в collapsed', async () => {
    mockArchiveApi.getArchiveGameById.mockResolvedValueOnce(baseGame);
    fetchMock.mockResolvedValueOnce(makeByPositionResp([]));

    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveGamePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-page')).toHaveAttribute(
        'data-state',
        'ready',
      ),
    );

    await user.click(screen.getByTestId('archive-other-games-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('archive-other-games')).toHaveAttribute(
        'data-state',
        'open',
      ),
    );

    // Переключаем ply — блок должен закрыться.
    await user.click(screen.getByTestId('archive-game-page-next'));
    await waitFor(() =>
      expect(screen.getByTestId('archive-other-games')).toHaveAttribute(
        'data-state',
        'closed',
      ),
    );
  });
});
