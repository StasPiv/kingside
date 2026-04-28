import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { ArchiveLobbyPage } from './ArchiveLobbyPage';
import { __buildSearchUrl } from '../components/archive/ArchiveSearchForm';

/**
 * KS-2067 (F1): юнит-тесты лобби архива.
 *
 * Покрытие:
 *  - URL-сборка из формы (`__buildSearchUrl`) — чистая функция.
 *  - ArchiveLobbyPage: header, форма, blok recent, CTA «Search by position».
 *  - Submit формы → navigate на `/archive/games?<query>`.
 *  - Recent games loading → data → клик → navigate.
 *  - Recent games error → retry перезапрашивает.
 *  - Autocomplete (player): debounce 250ms, минимум 2 символа,
 *    клик по item → значение прокидывается в input.
 */

const mockApi = {
  searchArchivePlayers: vi.fn(),
  searchArchiveEvents: vi.fn(),
  getArchiveGamesMetadata: vi.fn(),
};

vi.mock('../api/archive', () => ({
  archiveApi: {
    searchArchivePlayers: (...args: unknown[]) =>
      mockApi.searchArchivePlayers(...args),
    searchArchiveEvents: (...args: unknown[]) =>
      mockApi.searchArchiveEvents(...args),
    getArchiveGamesMetadata: (...args: unknown[]) =>
      mockApi.getArchiveGamesMetadata(...args),
  },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

beforeEach(() => {
  mockApi.searchArchivePlayers.mockReset();
  mockApi.searchArchiveEvents.mockReset();
  mockApi.getArchiveGamesMetadata.mockReset();
  mockNavigate.mockReset();
  // Дефолт: recent games пустые, чтобы тесты, которые их не интересует,
  // не зависели от них.
  mockApi.getArchiveGamesMetadata.mockResolvedValue({ total: 0, items: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── URL-builder ────────────────────────────────────────────────────

describe('__buildSearchUrl (ArchiveSearchForm)', () => {
  it('пустая форма → /archive/games без query', () => {
    expect(
      __buildSearchUrl({
        player: '',
        event: '',
        eco: '',
        sinceYear: '',
        untilYear: '',
        result: 'any',
        minElo: null,
        sort: 'recent',
      }),
    ).toBe('/archive/games');
  });

  it('заполненная форма → URL c фильтрами и преобразованием годов', () => {
    const url = __buildSearchUrl({
      player: 'Carlsen',
      event: 'Wijk aan Zee',
      eco: 'b90',
      sinceYear: '2020',
      untilYear: '2024',
      result: '1-0',
      minElo: 2700,
      sort: 'topElo',
    });
    const u = new URL(url, 'http://localhost');
    expect(u.pathname).toBe('/archive/games');
    expect(u.searchParams.get('player')).toBe('Carlsen');
    expect(u.searchParams.get('event')).toBe('Wijk aan Zee');
    // ECO upper-case'ится при сборке
    expect(u.searchParams.get('eco')).toBe('B90');
    expect(u.searchParams.get('since')).toBe('2020-01-01');
    expect(u.searchParams.get('until')).toBe('2024-12-31');
    expect(u.searchParams.get('result')).toBe('1-0');
    expect(u.searchParams.get('minElo')).toBe('2700');
    expect(u.searchParams.get('sort')).toBe('topElo');
  });
});

// ─── Страница ──────────────────────────────────────────────────────

describe('ArchiveLobbyPage — header и форма', () => {
  it('рендерит заголовок, форму, by-position CTA и блок Recent', async () => {
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });
    expect(screen.getByTestId('archive-lobby-page')).toBeInTheDocument();
    expect(screen.getByTestId('archive-search-form')).toBeInTheDocument();
    const cta = screen.getByTestId('archive-lobby-by-position-cta');
    expect(cta).toHaveAttribute('href', '/analysis');
    expect(screen.getByTestId('archive-lobby-recent')).toBeInTheDocument();
  });

  it('Submit формы → navigate на /archive/games с фильтрами', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });

    // ECO: `b9` — короче 3 символов в плейсхолдере, но мы примем «B90».
    const ecoInput = screen.getByTestId('archive-search-form-eco');
    await user.type(ecoInput, 'B90');
    await user.selectOptions(
      screen.getByTestId('archive-search-form-result'),
      '1-0',
    );
    await user.click(screen.getByTestId('archive-search-form-min-elo-2600'));
    await user.click(screen.getByTestId('archive-search-form-submit'));

    const arg = mockNavigate.mock.calls[0][0] as string;
    expect(arg).toMatch(/^\/archive\/games\?/);
    expect(arg).toContain('eco=B90');
    expect(arg).toContain('result=1-0');
    expect(arg).toContain('minElo=2600');
  });
});

describe('ArchiveLobbyPage — Recent games', () => {
  it('skeleton → данные → клик по строке → navigate на /archive/games/:id', async () => {
    mockApi.getArchiveGamesMetadata.mockReset();
    mockApi.getArchiveGamesMetadata.mockResolvedValueOnce({
      total: 1,
      items: [
        {
          id: 'g1',
          white: { name: 'A', slug: 'a', elo: 2600, title: null },
          black: { name: 'B', slug: 'b', elo: 2500, title: null },
          result: '1-0',
          eco: 'B90',
          opening: null,
          event: 'Test',
          date: '2024.01.15',
          plyCount: 60,
        },
      ],
    });
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });

    expect(screen.getByTestId('archive-lobby-recent-skeleton')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );
    expect(mockApi.getArchiveGamesMetadata).toHaveBeenCalledWith({
      sort: 'recent',
      limit: 10,
    });
    await user.click(screen.getByTestId('archive-game-row-g1'));
    expect(mockNavigate).toHaveBeenCalledWith('/archive/games/g1');
  });

  it('error → retry перезапрашивает', async () => {
    mockApi.getArchiveGamesMetadata.mockReset();
    mockApi.getArchiveGamesMetadata.mockRejectedValueOnce(new Error('boom'));
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });
    await waitFor(() =>
      expect(screen.getByTestId('archive-lobby-recent-error')).toBeInTheDocument(),
    );

    mockApi.getArchiveGamesMetadata.mockResolvedValueOnce({
      total: 0,
      items: [],
    });
    await user.click(screen.getByTestId('archive-lobby-recent-retry'));
    await waitFor(() =>
      expect(mockApi.getArchiveGamesMetadata).toHaveBeenCalledTimes(2),
    );
  });
});

describe('ArchiveLobbyPage — autocomplete по игрокам', () => {
  it('меньше 2 символов → fetch не вызывается, dropdown скрыт', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });
    const input = screen.getByTestId('archive-player-autocomplete-input');
    await user.type(input, 'A');
    // 1 символ — fetch не должен срабатывать.
    expect(mockApi.searchArchivePlayers).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId('archive-player-autocomplete-dropdown'),
    ).toBeNull();
  });

  it('≥ 2 символа → debounced fetch + dropdown с результатами + клик прокидывает имя', async () => {
    mockApi.searchArchivePlayers.mockResolvedValueOnce({
      total: 1,
      items: [
        { name: 'Magnus Carlsen', slug: 'magnus-carlsen', gamesCount: 4500, peakElo: 2882 },
      ],
    });
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });
    const input = screen.getByTestId('archive-player-autocomplete-input');
    await user.type(input, 'Ma');

    // debounce 250 ms — ждём, пока fetch отстреляется.
    await waitFor(
      () => expect(mockApi.searchArchivePlayers).toHaveBeenCalledWith('Ma', 10),
      { timeout: 1500 },
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('archive-player-autocomplete-item-magnus-carlsen'),
      ).toBeInTheDocument(),
    );

    await user.click(
      screen.getByTestId('archive-player-autocomplete-item-magnus-carlsen'),
    );
    expect((input as HTMLInputElement).value).toBe('Magnus Carlsen');
  });
});
