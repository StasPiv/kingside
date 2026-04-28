import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderWithProviders,
  screen,
  waitFor,
} from '../test/test-utils';
import {
  ArchiveGamesPage,
  metadataFiltersToRequest,
  metadataFiltersToUrl,
  urlToMetadataFilters,
} from './ArchiveGamesPage';
import { EMPTY_METADATA_FILTERS } from '../components/archive/ArchiveMetadataFilters';

/**
 * KS-2068 (F2): юнит-тесты универсального списка архива партий.
 *
 * Покрытие:
 *  - dispatch по `?fen=`: by-position режим vs metadata.
 *  - URL ↔ filters трансформации (`urlTo*`/`*ToUrl`/`*ToRequest`).
 *  - Состояния списка metadata-режима: loading skeleton / empty / data /
 *    pagination (prev/next/page-size).
 *  - Изменение фильтра сбрасывает page=1, обновляет URL.
 *  - Ряд → клик по строке → navigate('/archive/games/<id>').
 *
 * Мокаем `archiveApi.getArchiveGamesMetadata` (для metadata-режима) и
 * `useArchiveGamesByPosition` (для by-position-режима — иначе он бы
 * стучался в реальный fetch и проваливал тесты).
 */

const mockGetGamesMetadata = vi.fn();

vi.mock('../api/archive', () => ({
  archiveApi: {
    getArchiveGamesMetadata: (...args: unknown[]) =>
      mockGetGamesMetadata(...args),
  },
}));

vi.mock('../hooks/useArchiveGamesByPosition', () => ({
  useArchiveGamesByPosition: () => ({
    items: [],
    hasMore: false,
    nextCursor: null,
    totalApprox: 0,
    isLoading: false,
    isLoadingMore: false,
    error: null,
    loadMore: () => {},
    refetch: () => {},
  }),
}));

// `ArchivePositionHeader` рендерит мини-доску через `react-chessboard`,
// которая в happy-dom падает «Square width not found». Для теста F2
// нам важен только факт делегирования к by-position-странице — поэтому
// заменяем header на лёгкий <div>.
vi.mock('../components/archive/ArchivePositionHeader', () => ({
  ArchivePositionHeader: () => <div data-testid="archive-position-header-stub" />,
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
  mockGetGamesMetadata.mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleResponse = {
  total: 42,
  items: [
    {
      id: 'g1',
      white: { name: 'Magnus Carlsen', slug: 'magnus-carlsen', elo: 2870, title: 'GM' },
      black: { name: 'Hikaru Nakamura', slug: 'hikaru-nakamura', elo: 2780, title: 'GM' },
      result: '1-0' as const,
      eco: 'C42',
      opening: 'Petroff Defense',
      event: 'World Cup',
      date: '2024.01.15',
      plyCount: 60,
    },
    {
      id: 'g2',
      white: { name: 'Fabiano Caruana', slug: 'fabiano-caruana', elo: 2810, title: 'GM' },
      black: { name: 'Magnus Carlsen', slug: 'magnus-carlsen', elo: 2870, title: 'GM' },
      result: '1/2-1/2' as const,
      eco: 'B90',
      opening: 'Sicilian',
      event: 'Norway Chess',
      date: '2024.06.10',
      plyCount: 80,
    },
  ],
};

// ─── URL ↔ filters ──────────────────────────────────────────────────

describe('urlToMetadataFilters', () => {
  it('пустой URL → дефолты', () => {
    expect(urlToMetadataFilters(new URLSearchParams())).toEqual(
      EMPTY_METADATA_FILTERS,
    );
  });

  it('читает все поля из query', () => {
    const params = new URLSearchParams(
      'player=Carlsen&event=Wijk&eco=C42&result=1-0&minElo=2600&since=2020-01-01&until=2024-01-01&minPly=20&maxPly=80&sort=topElo',
    );
    expect(urlToMetadataFilters(params)).toEqual({
      players: ['Carlsen'],
      event: 'Wijk',
      eco: 'C42',
      result: '1-0',
      minElo: 2600,
      since: '2020-01-01',
      until: '2024-01-01',
      minPly: 20,
      maxPly: 80,
      sort: 'topElo',
    });
  });

  it('KS-2084: несколько ?player= в URL → массив', () => {
    const params = new URLSearchParams(
      'player=Carlsen,M&player=Caruana,F&result=1-0',
    );
    const r = urlToMetadataFilters(params);
    expect(r.players).toEqual(['Carlsen,M', 'Caruana,F']);
    expect(r.result).toBe('1-0');
  });

  it('невалидный sort/result/minElo откатывает к дефолту', () => {
    const params = new URLSearchParams('sort=lol&result=foo&minElo=NaN');
    const r = urlToMetadataFilters(params);
    expect(r.sort).toBe('recent');
    expect(r.result).toBe('any');
    expect(r.minElo).toBeNull();
  });
});

describe('metadataFiltersToUrl', () => {
  it('дефолтные фильтры + page=1 + pageSize=20 → пустой query', () => {
    const params = metadataFiltersToUrl(EMPTY_METADATA_FILTERS, 1, 20);
    expect(params.toString()).toBe('');
  });

  it('сериализует все непустые поля + page>1 + pageSize≠20', () => {
    const params = metadataFiltersToUrl(
      {
        players: ['Carlsen'],
        event: 'Wijk',
        eco: 'B90',
        result: '1-0',
        minElo: 2700,
        since: '2020-01-01',
        until: '2024-01-01',
        minPly: 20,
        maxPly: 80,
        sort: 'topElo',
      },
      3,
      50,
    );
    expect(params.get('player')).toBe('Carlsen');
    expect(params.get('event')).toBe('Wijk');
    expect(params.get('eco')).toBe('B90');
    expect(params.get('result')).toBe('1-0');
    expect(params.get('minElo')).toBe('2700');
    expect(params.get('since')).toBe('2020-01-01');
    expect(params.get('until')).toBe('2024-01-01');
    expect(params.get('minPly')).toBe('20');
    expect(params.get('maxPly')).toBe('80');
    expect(params.get('sort')).toBe('topElo');
    expect(params.get('page')).toBe('3');
    expect(params.get('pageSize')).toBe('50');
  });
});

describe('metadataFiltersToRequest', () => {
  it('дефолты → limit/offset + sort, остальные undefined', () => {
    const r = metadataFiltersToRequest(EMPTY_METADATA_FILTERS, 1, 20);
    expect(r.limit).toBe(20);
    expect(r.offset).toBe(0);
    expect(r.sort).toBe('recent');
    expect(r.player).toBeUndefined();
    expect(r.minElo).toBeUndefined();
    expect(r.result).toBeUndefined();
  });

  it('page=3, pageSize=50 → offset=100', () => {
    const r = metadataFiltersToRequest(EMPTY_METADATA_FILTERS, 3, 50);
    expect(r.offset).toBe(100);
    expect(r.limit).toBe(50);
  });

  it('result=any → undefined в request', () => {
    const r = metadataFiltersToRequest(
      { ...EMPTY_METADATA_FILTERS, result: 'any' },
      1,
      20,
    );
    expect(r.result).toBeUndefined();
  });
});

// ─── Страница ──────────────────────────────────────────────────────

describe('ArchiveGamesPage — dispatch по ?fen=', () => {
  it('без ?fen= → metadata режим', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce(sampleResponse);
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });
    await waitFor(() =>
      expect(screen.getByTestId('archive-games-page')).toHaveAttribute(
        'data-mode',
        'metadata',
      ),
    );
  });

  it('с ?fen= → by-position режим (рендер делегируется существующему компоненту)', async () => {
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games?fen=startpos',
    });
    // by-position-страница не имеет `data-mode="metadata"`. Достаточно
    // убедиться, что мы НЕ показали metadata-summary.
    await waitFor(() =>
      expect(screen.queryByTestId('archive-games-metadata-summary')).toBeNull(),
    );
  });
});

describe('ArchiveGamesPage — metadata режим', () => {
  it('skeleton → данные → строки рендерятся', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce(sampleResponse);
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });

    expect(screen.getByTestId('archive-games-skeleton')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('archive-game-row-g2')).toBeInTheDocument();
    expect(screen.getByTestId('archive-games-metadata-total').textContent).toMatch(
      /42/,
    );
  });

  it('пустой ответ + активные фильтры → empty + Reset filters', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce({ total: 0, items: [] });
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games?player=Carlsen',
    });

    await waitFor(() =>
      expect(screen.getByTestId('archive-games-empty')).toBeInTheDocument(),
    );
    const reset = screen.getByTestId('archive-games-reset-filters');
    expect(reset).toBeInTheDocument();

    mockGetGamesMetadata.mockResolvedValueOnce({ total: 0, items: [] });
    await user.click(reset);
    // После сброса URL очищается — страница должна перезапросить без player.
    await waitFor(() =>
      expect(mockGetGamesMetadata).toHaveBeenLastCalledWith(
        expect.objectContaining({ player: undefined }),
      ),
    );
  });

  it('пустой ответ без фильтров → empty без Reset filters', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce({ total: 0, items: [] });
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });
    await waitFor(() =>
      expect(screen.getByTestId('archive-games-empty')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('archive-games-reset-filters')).toBeNull();
  });

  it('Next переходит на страницу 2 (offset=20)', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce(sampleResponse);
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );

    mockGetGamesMetadata.mockResolvedValueOnce({
      total: 42,
      items: [sampleResponse.items[1]],
    });
    await user.click(screen.getByTestId('archive-games-metadata-next'));

    await waitFor(() =>
      expect(mockGetGamesMetadata).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 20 }),
      ),
    );
  });

  it('изменение page-size сбрасывает page → 1', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce(sampleResponse);
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games?page=3',
    });
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );

    mockGetGamesMetadata.mockResolvedValueOnce(sampleResponse);
    await user.selectOptions(
      screen.getByTestId('archive-games-metadata-page-size'),
      '50',
    );
    await waitFor(() =>
      expect(mockGetGamesMetadata).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: 50, offset: 0 }),
      ),
    );
  });

  it('клик по строке → navigate(/archive/games/<id>)', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce(sampleResponse);
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('archive-game-row-g1'));
    expect(mockNavigate).toHaveBeenCalledWith('/archive/games/g1');
  });

  it('клик по имени игрока НЕ зовёт row-onClick (Link перехватывает)', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce(sampleResponse);
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );
    const whiteLink = screen.getByTestId(
      'archive-game-row-g1-white-link',
    );
    expect(whiteLink).toHaveAttribute('href', '/archive/players/magnus-carlsen');

    await user.click(whiteLink);
    // navigate('/archive/games/...') не должен быть вызван — это Link
    // на профиль, переход делает react-router сам.
    expect(mockNavigate).not.toHaveBeenCalledWith('/archive/games/g1');
  });

  it('изменение фильтра sort через select → URL обновляется, page=1', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce(sampleResponse);
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games?page=2',
    });

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );

    mockGetGamesMetadata.mockResolvedValueOnce(sampleResponse);
    await user.selectOptions(
      screen.getByTestId('archive-metadata-filter-sort'),
      'topElo',
    );

    await waitFor(() =>
      expect(mockGetGamesMetadata).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'topElo', offset: 0 }),
      ),
    );
  });
});
