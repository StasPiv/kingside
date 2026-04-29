import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { ArchiveLobbyPage } from './ArchiveLobbyPage';
import { __buildSearchUrl } from '../components/archive/ArchiveSearchForm';
import { EMPTY_FILTERS } from '../components/archive/ArchiveFiltersForm';

/**
 * KS-2067/KS-2125: юнит-тесты лобби архива.
 *
 * После KS-2125 форма поиска (`ArchiveSearchForm`) — тонкая обёртка
 * над общим `ArchiveFiltersForm` с autoNavigate-семантикой:
 * любое изменение фильтра ⇒ navigate('/archive/games?<query>').
 *
 * Покрытие:
 *  - URL-сборка (`__buildSearchUrl`) — чистая функция.
 *  - Lobby рендерит форму, by-position CTA и Recent games.
 *  - Изменение любого фильтра → autoNavigate.
 *  - Reset all → state очищается + navigate('/archive').
 *  - Recent games loading/data/retry.
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
  // Дефолт: recent games пустые, чтобы тесты, которые их не интересуют,
  // не зависели от них.
  mockApi.getArchiveGamesMetadata.mockResolvedValue({ total: 0, items: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── URL-builder ────────────────────────────────────────────────────

describe('__buildSearchUrl (ArchiveSearchForm)', () => {
  it('пустые фильтры → /archive/games без query', () => {
    expect(__buildSearchUrl(EMPTY_FILTERS)).toBe('/archive/games');
  });

  it('KS-2084: несколько игроков → несколько ?player=', () => {
    const url = __buildSearchUrl({
      ...EMPTY_FILTERS,
      players: ['Carlsen,M', 'Caruana,F'],
    });
    const u = new URL(url, 'http://localhost');
    expect(u.searchParams.getAll('player')).toEqual([
      'Carlsen,M',
      'Caruana,F',
    ]);
  });

  it('заполненная форма → URL c фильтрами и ISO-датами', () => {
    const url = __buildSearchUrl({
      ...EMPTY_FILTERS,
      players: ['Carlsen'],
      event: 'Wijk aan Zee',
      eco: 'B90',
      since: '2020-01-01',
      until: '2024-12-31',
      result: '1-0',
      minElo: 2700,
      sort: 'topElo',
    });
    const u = new URL(url, 'http://localhost');
    expect(u.pathname).toBe('/archive/games');
    expect(u.searchParams.get('player')).toBe('Carlsen');
    expect(u.searchParams.get('event')).toBe('Wijk aan Zee');
    expect(u.searchParams.get('eco')).toBe('B90');
    expect(u.searchParams.get('since')).toBe('2020-01-01');
    expect(u.searchParams.get('until')).toBe('2024-12-31');
    expect(u.searchParams.get('result')).toBe('1-0');
    expect(u.searchParams.get('minElo')).toBe('2700');
    expect(u.searchParams.get('sort')).toBe('topElo');
  });

  it('KS-2122: timeControlCategory массивом → дубликаты query', () => {
    const url = __buildSearchUrl({
      ...EMPTY_FILTERS,
      timeControlCategory: ['classical', 'rapid'],
    });
    const u = new URL(url, 'http://localhost');
    expect(u.searchParams.getAll('timeControlCategory')).toEqual([
      'classical',
      'rapid',
    ]);
  });

  it('KS-2125: minPly/maxPly сериализуются', () => {
    const url = __buildSearchUrl({
      ...EMPTY_FILTERS,
      minPly: 30,
      maxPly: 80,
    });
    const u = new URL(url, 'http://localhost');
    expect(u.searchParams.get('minPly')).toBe('30');
    expect(u.searchParams.get('maxPly')).toBe('80');
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

  it('KS-2125: расширенный набор полей виден на лобби', async () => {
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });
    expect(screen.getByTestId('archive-search-form-sort')).toBeInTheDocument();
    expect(screen.getByTestId('archive-search-form-result')).toBeInTheDocument();
    expect(screen.getByTestId('archive-search-form-min-elo-any')).toBeInTheDocument();
    expect(
      screen.getByTestId('archive-search-form-time-control-classical'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('archive-search-form-since')).toBeInTheDocument();
    expect(screen.getByTestId('archive-search-form-until')).toBeInTheDocument();
    expect(
      screen.getByTestId('archive-search-form-player-input'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('archive-search-form-event')).toBeInTheDocument();
    expect(screen.getByTestId('archive-search-form-eco')).toBeInTheDocument();
    expect(screen.getByTestId('archive-search-form-min-ply')).toBeInTheDocument();
    expect(screen.getByTestId('archive-search-form-max-ply')).toBeInTheDocument();
  });

  it('KS-2125: клик по «Классика» → autoNavigate на /archive/games?timeControlCategory=classical', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });

    await user.click(
      screen.getByTestId('archive-search-form-time-control-classical'),
    );
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const arg = mockNavigate.mock.calls[0][0] as string;
    expect(arg).toBe('/archive/games?timeControlCategory=classical');
  });

  it('KS-2125: клик по «Min Elo 2600» → autoNavigate', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });

    await user.click(screen.getByTestId('archive-search-form-min-elo-2600'));
    expect(mockNavigate).toHaveBeenCalledWith(
      '/archive/games?minElo=2600',
    );
  });

  it('KS-2125: смена sort на «recent» (default) не уводит со страницы', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });

    // sort уже recent → выбор того же значения не меняет state и не
    // должен дёргать navigate. Проверяем через выбор любой опции:
    // меняем на topElo (autoNavigate), потом возвращаем на recent —
    // recent является дефолтом, autoNavigate не сработает.
    await user.selectOptions(
      screen.getByTestId('archive-search-form-sort'),
      'topElo',
    );
    expect(mockNavigate).toHaveBeenCalledWith(
      '/archive/games?sort=topElo',
    );

    mockNavigate.mockClear();
    await user.selectOptions(
      screen.getByTestId('archive-search-form-sort'),
      'recent',
    );
    // sort=recent → state «пустой» → autoNavigate подавлен.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('KS-2125: Reset all → navigate(/archive)', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });

    // Сначала ставим фильтр.
    await user.click(
      screen.getByTestId('archive-search-form-time-control-classical'),
    );
    expect(mockNavigate).toHaveBeenCalledTimes(1);

    // Потом сбрасываем.
    await user.click(screen.getByTestId('archive-search-form-reset'));
    expect(mockNavigate).toHaveBeenLastCalledWith('/archive');
  });

  it('KS-2125: Enter в Player input добавляет chip и autoNavigate', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });

    const input = screen.getByTestId(
      'archive-search-form-player-input',
    ) as HTMLInputElement;
    await user.type(input, 'Carlsen');
    await user.keyboard('{Enter}');

    expect(input.value).toBe('');
    expect(
      screen.getByTestId('archive-search-form-player-chip-Carlsen'),
    ).toBeInTheDocument();
    expect(mockNavigate).toHaveBeenCalledWith(
      '/archive/games?player=Carlsen',
    );
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
