import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import {
  ArchivePlayerProfilePage,
  playerStateToRequest,
  playerStateToUrl,
  urlToPlayerState,
} from './ArchivePlayerProfilePage';
import { EMPTY_METADATA_FILTERS } from '../components/archive/ArchiveMetadataFilters';

/**
 * KS-2069 (F3): юнит-тесты страницы профиля игрока.
 *
 * Покрытие:
 *  - URL ↔ state: фильтры + color + page + pageSize.
 *  - Header: имя, peakElo, byColor/byResult с bar-сегментами.
 *  - 404 на rejected `getArchivePlayerProfile` со статусом 404.
 *  - Список партий: loading skeleton / empty / data / pagination /
 *    клик по строке → `/archive/games/:id`.
 *  - Изменение color-фильтра обновляет URL и сбрасывает page=1.
 *
 * Мокаем `archiveApi` целиком + `useParams`/`useNavigate`.
 */

const mockApi = {
  getArchivePlayerProfile: vi.fn(),
  getArchivePlayerGames: vi.fn(),
};

vi.mock('../api/archive', () => ({
  archiveApi: {
    getArchivePlayerProfile: (...args: unknown[]) =>
      mockApi.getArchivePlayerProfile(...args),
    getArchivePlayerGames: (...args: unknown[]) =>
      mockApi.getArchivePlayerGames(...args),
  },
}));

const mockNavigate = vi.fn();
const mockUseParams = vi.fn(() => ({ slug: 'magnus-carlsen' }));

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

const baseProfile = {
  name: 'Magnus Carlsen',
  slug: 'magnus-carlsen',
  gamesCount: 4500,
  peakElo: 2882,
  byColor: { white: 2400, black: 2100 },
  byResult: { wins: 2000, draws: 1800, losses: 700 },
  firstSeenAt: '2003-01-15',
  lastSeenAt: '2024-06-10',
};

const baseGames = {
  total: 50,
  items: [
    {
      id: 'g1',
      white: { name: 'Magnus Carlsen', slug: 'magnus-carlsen', elo: 2870, title: 'GM' },
      black: { name: 'Hikaru Nakamura', slug: 'hikaru-nakamura', elo: 2780, title: 'GM' },
      result: '1-0' as const,
      eco: 'C42',
      opening: 'Petroff',
      event: 'World Cup',
      date: '2024.01.15',
      plyCount: 60,
      playerColor: 'white' as const,
    },
    {
      id: 'g2',
      white: { name: 'Fabiano Caruana', slug: 'fabiano-caruana', elo: 2810, title: 'GM' },
      black: { name: 'Magnus Carlsen', slug: 'magnus-carlsen', elo: 2870, title: 'GM' },
      result: '0-1' as const,
      eco: 'B90',
      opening: 'Sicilian',
      event: 'Norway',
      date: '2024.06.10',
      plyCount: 80,
      playerColor: 'black' as const,
    },
  ],
};

beforeEach(() => {
  mockApi.getArchivePlayerProfile.mockReset();
  mockApi.getArchivePlayerGames.mockReset();
  mockNavigate.mockReset();
  mockUseParams.mockReset();
  mockUseParams.mockReturnValue({ slug: 'magnus-carlsen' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── URL ↔ state ────────────────────────────────────────────────────

describe('urlToPlayerState', () => {
  it('пустой URL → дефолты', () => {
    const s = urlToPlayerState(new URLSearchParams());
    expect(s).toEqual({
      filters: EMPTY_METADATA_FILTERS,
      color: 'any',
      page: 1,
      pageSize: 20,
    });
  });

  it('полный URL читается корректно', () => {
    const params = new URLSearchParams(
      'event=Wijk&eco=B90&result=1-0&minElo=2700&since=2020-01-01&until=2024-01-01&minPly=20&maxPly=80&sort=topElo&color=white&page=3&pageSize=50',
    );
    const s = urlToPlayerState(params);
    expect(s.color).toBe('white');
    expect(s.page).toBe(3);
    expect(s.pageSize).toBe(50);
    expect(s.filters.event).toBe('Wijk');
    expect(s.filters.sort).toBe('topElo');
    expect(s.filters.minElo).toBe(2700);
  });

  it('невалидный color → any, невалидный pageSize → 20', () => {
    const s = urlToPlayerState(new URLSearchParams('color=red&pageSize=999'));
    expect(s.color).toBe('any');
    expect(s.pageSize).toBe(20);
  });
});

describe('playerStateToUrl', () => {
  it('дефолтное состояние → пустой query', () => {
    const params = playerStateToUrl({
      filters: EMPTY_METADATA_FILTERS,
      color: 'any',
      page: 1,
      pageSize: 20,
    });
    expect(params.toString()).toBe('');
  });

  it('color=white + page=2 + pageSize=50 → корректный query', () => {
    const params = playerStateToUrl({
      filters: EMPTY_METADATA_FILTERS,
      color: 'white',
      page: 2,
      pageSize: 50,
    });
    expect(params.get('color')).toBe('white');
    expect(params.get('page')).toBe('2');
    expect(params.get('pageSize')).toBe('50');
  });
});

describe('playerStateToRequest', () => {
  it('color=any остаётся в request (бэк сам интерпретирует)', () => {
    const r = playerStateToRequest({
      filters: EMPTY_METADATA_FILTERS,
      color: 'any',
      page: 1,
      pageSize: 20,
    });
    expect(r.color).toBe('any');
    expect(r.limit).toBe(20);
    expect(r.offset).toBe(0);
  });

  it('page=3 + pageSize=50 → offset=100', () => {
    const r = playerStateToRequest({
      filters: EMPTY_METADATA_FILTERS,
      color: 'white',
      page: 3,
      pageSize: 50,
    });
    expect(r.offset).toBe(100);
    expect(r.limit).toBe(50);
    expect(r.color).toBe('white');
  });
});

// ─── Страница ──────────────────────────────────────────────────────

describe('ArchivePlayerProfilePage — header', () => {
  it('рендерит имя, gamesCount, peakElo, период', async () => {
    mockApi.getArchivePlayerProfile.mockResolvedValueOnce(baseProfile);
    mockApi.getArchivePlayerGames.mockResolvedValueOnce(baseGames);

    renderWithProviders(<ArchivePlayerProfilePage />);

    await waitFor(() =>
      expect(screen.getByTestId('archive-player-profile-page')).toHaveAttribute(
        'data-state',
        'ready',
      ),
    );

    expect(mockApi.getArchivePlayerProfile).toHaveBeenCalledWith(
      'magnus-carlsen',
    );
    expect(screen.getByTestId('archive-player-profile-name')).toHaveTextContent(
      'Magnus Carlsen',
    );
    expect(
      screen.getByTestId('archive-player-profile-games-count'),
    ).toHaveTextContent('4500');
    expect(
      screen.getByTestId('archive-player-profile-peak-elo'),
    ).toHaveTextContent('2882');
    expect(
      screen.getByTestId('archive-player-profile-period').textContent,
    ).toMatch(/2003-01-15.*2024-06-10/);
  });

  it('byResult-bar — сегменты с правильной шириной', async () => {
    mockApi.getArchivePlayerProfile.mockResolvedValueOnce(baseProfile);
    mockApi.getArchivePlayerGames.mockResolvedValueOnce(baseGames);

    renderWithProviders(<ArchivePlayerProfilePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-player-profile-page')).toHaveAttribute(
        'data-state',
        'ready',
      ),
    );

    const win = screen.getByTestId('archive-player-profile-by-result-win');
    const draw = screen.getByTestId('archive-player-profile-by-result-draw');
    const loss = screen.getByTestId('archive-player-profile-by-result-loss');
    // 2000/4500 = 44%, 1800/4500 = 40%, 700/4500 = 16%
    expect(win.getAttribute('style')).toContain('width: 44%');
    expect(draw.getAttribute('style')).toContain('width: 40%');
    expect(loss.getAttribute('style')).toContain('width: 16%');
  });
});

describe('ArchivePlayerProfilePage — 404', () => {
  it('rejection с 404 → экран Player not found с возвратом', async () => {
    mockApi.getArchivePlayerProfile.mockRejectedValueOnce(
      new Error('Archive request failed: 404'),
    );

    renderWithProviders(<ArchivePlayerProfilePage />);

    await waitFor(() =>
      expect(screen.getByTestId('archive-player-profile-page')).toHaveAttribute(
        'data-state',
        'not-found',
      ),
    );
    expect(screen.getByTestId('archive-player-profile-back')).toHaveAttribute(
      'href',
      '/archive',
    );
    // Партии не должны грузиться при 404 на профиль.
    expect(mockApi.getArchivePlayerGames).not.toHaveBeenCalled();
  });

  it('прочая ошибка → load_error', async () => {
    mockApi.getArchivePlayerProfile.mockRejectedValueOnce(
      new Error('Network down'),
    );

    renderWithProviders(<ArchivePlayerProfilePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-player-profile-page')).toHaveAttribute(
        'data-state',
        'error',
      ),
    );
  });
});

describe('ArchivePlayerProfilePage — список и фильтры', () => {
  it('рендерит партии + клик → navigate(/archive/games/:id)', async () => {
    mockApi.getArchivePlayerProfile.mockResolvedValueOnce(baseProfile);
    mockApi.getArchivePlayerGames.mockResolvedValueOnce(baseGames);
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchivePlayerProfilePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('archive-game-row-g1'));
    expect(mockNavigate).toHaveBeenCalledWith('/archive/games/g1');
  });

  it('пустой список + активный color-фильтр → empty + Reset filters', async () => {
    mockApi.getArchivePlayerProfile.mockResolvedValueOnce(baseProfile);
    mockApi.getArchivePlayerGames.mockResolvedValueOnce({ total: 0, items: [] });
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchivePlayerProfilePage />, {
      route: '/archive/players/magnus-carlsen?color=white',
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('archive-player-profile-games-empty'),
      ).toBeInTheDocument(),
    );
    const reset = screen.getByTestId('archive-player-profile-reset-filters');
    expect(reset).toBeInTheDocument();

    mockApi.getArchivePlayerGames.mockResolvedValueOnce({ total: 0, items: [] });
    await user.click(reset);
    await waitFor(() =>
      expect(mockApi.getArchivePlayerGames).toHaveBeenLastCalledWith(
        'magnus-carlsen',
        expect.objectContaining({ color: 'any' }),
      ),
    );
  });

  it('изменение color → запрос с новым color, page=1', async () => {
    mockApi.getArchivePlayerProfile.mockResolvedValueOnce(baseProfile);
    mockApi.getArchivePlayerGames.mockResolvedValueOnce(baseGames);
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchivePlayerProfilePage />, {
      route: '/archive/players/magnus-carlsen?page=2',
    });
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );

    mockApi.getArchivePlayerGames.mockResolvedValueOnce(baseGames);
    await user.selectOptions(
      screen.getByTestId('archive-player-filter-color'),
      'white',
    );
    await waitFor(() =>
      expect(mockApi.getArchivePlayerGames).toHaveBeenLastCalledWith(
        'magnus-carlsen',
        expect.objectContaining({ color: 'white', offset: 0 }),
      ),
    );
  });

  it('Next → offset+=pageSize', async () => {
    mockApi.getArchivePlayerProfile.mockResolvedValueOnce(baseProfile);
    mockApi.getArchivePlayerGames.mockResolvedValueOnce(baseGames);
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchivePlayerProfilePage />);
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );

    mockApi.getArchivePlayerGames.mockResolvedValueOnce(baseGames);
    await user.click(screen.getByTestId('archive-player-profile-next'));
    await waitFor(() =>
      expect(mockApi.getArchivePlayerGames).toHaveBeenLastCalledWith(
        'magnus-carlsen',
        expect.objectContaining({ offset: 20 }),
      ),
    );
  });
});
