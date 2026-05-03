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
// KS-2219: при клике по строке `ArchiveGamesPage` грузит партию через
// `archiveApi.getArchiveGameById` и при успехе уходит в `/analysis`,
// при ошибке — fallback `navigate('/archive/games/<id>')`. Раньше мок
// этого метода отсутствовал, и тест падал тихо (handleRowClick
// проваливался в catch до navigate из-за `archiveApi.getArchiveGameById is not a function`).
const mockGetGameById = vi.fn();

vi.mock('../api/archive', () => ({
  archiveApi: {
    getArchiveGamesMetadata: (...args: unknown[]) =>
      mockGetGamesMetadata(...args),
    getArchiveGameById: (...args: unknown[]) => mockGetGameById(...args),
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
  mockGetGameById.mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleResponse = {
  total: 42,
  // KS-2141: с расширенным `skipTotal` бэкенд считает COUNT только для
  // clean recent (cache-path); во всех остальных случаях возвращает
  // `total: null`. `hasNext` — обязательное поле для пагинации.
  hasNext: true,
  // KS-2143: keyset cursor для следующей страницы (null = конец).
  nextCursor: 'cursor-page-2',
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
      timeControlCategory: [],
    });
  });

  it('KS-2115: несколько ?timeControlCategory в URL → массив', () => {
    const params = new URLSearchParams(
      'timeControlCategory=classical&timeControlCategory=rapid',
    );
    const r = urlToMetadataFilters(params);
    expect(r.timeControlCategory).toEqual(['classical', 'rapid']);
  });

  it('KS-2115: невалидное значение timeControlCategory отбрасывается', () => {
    const params = new URLSearchParams(
      'timeControlCategory=classical&timeControlCategory=banana',
    );
    const r = urlToMetadataFilters(params);
    expect(r.timeControlCategory).toEqual(['classical']);
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
        timeControlCategory: ['classical', 'rapid'],
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
    expect(params.getAll('timeControlCategory')).toEqual([
      'classical',
      'rapid',
    ]);
    expect(params.get('page')).toBe('3');
    expect(params.get('pageSize')).toBe('50');
  });

  it('KS-2115: пустой timeControlCategory не добавляется в query', () => {
    const params = metadataFiltersToUrl(EMPTY_METADATA_FILTERS, 1, 20);
    expect(params.getAll('timeControlCategory')).toEqual([]);
  });
});

describe('metadataFiltersToUrl — KS-2143 cursor', () => {
  it('cursor + page>1 → ?cursor=… в URL', () => {
    const params = metadataFiltersToUrl(EMPTY_METADATA_FILTERS, 2, 20, 'abc');
    expect(params.get('cursor')).toBe('abc');
    expect(params.get('page')).toBe('2');
  });
  it('cursor + page=1 → ?cursor НЕ кладётся (1-я страница без cursor)', () => {
    const params = metadataFiltersToUrl(EMPTY_METADATA_FILTERS, 1, 20, 'abc');
    expect(params.get('cursor')).toBeNull();
  });
  it('пустой cursor → ?cursor НЕ кладётся', () => {
    const params = metadataFiltersToUrl(EMPTY_METADATA_FILTERS, 2, 20, '');
    expect(params.get('cursor')).toBeNull();
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

  it('KS-2115: timeControlCategory []/[1]/[2+] → undefined/string/string[]', () => {
    expect(
      metadataFiltersToRequest(EMPTY_METADATA_FILTERS, 1, 20)
        .timeControlCategory,
    ).toBeUndefined();
    expect(
      metadataFiltersToRequest(
        { ...EMPTY_METADATA_FILTERS, timeControlCategory: ['classical'] },
        1,
        20,
      ).timeControlCategory,
    ).toBe('classical');
    expect(
      metadataFiltersToRequest(
        {
          ...EMPTY_METADATA_FILTERS,
          timeControlCategory: ['classical', 'rapid'],
        },
        1,
        20,
      ).timeControlCategory,
    ).toEqual(['classical', 'rapid']);
  });

  // KS-2143: cursor приоритетнее offset
  it('cursor задан → request с cursor, offset=undefined', () => {
    const r = metadataFiltersToRequest(EMPTY_METADATA_FILTERS, 3, 20, 'abc');
    expect(r.cursor).toBe('abc');
    expect(r.offset).toBeUndefined();
  });
  it('cursor не задан → fallback offset=(page-1)*pageSize', () => {
    const r = metadataFiltersToRequest(EMPTY_METADATA_FILTERS, 3, 20);
    expect(r.cursor).toBeUndefined();
    expect(r.offset).toBe(40);
  });
  it('cursor пустая строка → fallback offset (трактуем как «нет cursor»)', () => {
    const r = metadataFiltersToRequest(EMPTY_METADATA_FILTERS, 2, 20, '');
    expect(r.cursor).toBeUndefined();
    expect(r.offset).toBe(20);
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
    mockGetGamesMetadata.mockResolvedValueOnce({ total: 0, hasNext: false, items: [] });
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games?player=Carlsen',
    });

    await waitFor(() =>
      expect(screen.getByTestId('archive-games-empty')).toBeInTheDocument(),
    );
    const reset = screen.getByTestId('archive-games-reset-filters');
    expect(reset).toBeInTheDocument();

    mockGetGamesMetadata.mockResolvedValueOnce({ total: 0, hasNext: false, items: [] });
    await user.click(reset);
    // После сброса URL очищается — страница должна перезапросить без player.
    await waitFor(() =>
      expect(mockGetGamesMetadata).toHaveBeenLastCalledWith(
        expect.objectContaining({ player: undefined }),
        expect.anything(),
      ),
    );
  });

  it('пустой ответ без фильтров → empty без Reset filters', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce({ total: 0, hasNext: false, items: [] });
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });
    await waitFor(() =>
      expect(screen.getByTestId('archive-games-empty')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('archive-games-reset-filters')).toBeNull();
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
        expect.anything(),
      ),
    );
  });

  it('KS-2219: клик по строке (успех getArchiveGameById) → navigate(/analysis)', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce(sampleResponse);
    // KS-2210/F4: страница пытается загрузить PGN партии и сразу открыть
    // её в анализаторе (`/analysis`), а на детальный URL уходит только
    // как fallback при ошибке загрузки.
    mockGetGameById.mockResolvedValueOnce({
      id: 'g1',
      pgn: '1. e4 e5',
      white: { name: 'Magnus Carlsen', slug: 'magnus-carlsen', elo: 2870, title: 'GM' },
      black: { name: 'Hikaru Nakamura', slug: 'hikaru-nakamura', elo: 2780, title: 'GM' },
      result: '1-0',
      eco: 'C42',
      opening: 'Petroff',
      event: 'World Cup',
      date: '2024.01.15',
      plyCount: 60,
    });
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive' });

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('archive-game-row-g1'));
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        '/analysis',
        expect.objectContaining({
          state: expect.objectContaining({
            pgn: '1. e4 e5',
            title: 'Magnus Carlsen vs Hikaru Nakamura',
            breadcrumbRootUrl: '/archive',
          }),
        }),
      ),
    );
  });

  it('KS-2219: клик по строке (ошибка getArchiveGameById) → fallback navigate(/archive/games/<id>)', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce(sampleResponse);
    mockGetGameById.mockRejectedValueOnce(new Error('boom'));
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive' });

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('archive-game-row-g1'));
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/archive/games/g1'),
    );
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
        expect.anything(),
      ),
    );
  });

  // ─── KS-2141: total nullable ─────────────────────────────────────
  it('KS-2141: `total === null` → счётчик «Total: N» скрыт', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce({
      total: null,
      hasNext: true,
      nextCursor: 'C2',
      items: sampleResponse.items,
    });
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('archive-games-metadata-total')).toBeNull();
  });

  it('KS-2141: `total: 42` (cache-path recent) → «Total: 42» виден', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce({
      total: 42,
      hasNext: true,
      nextCursor: 'C2',
      items: sampleResponse.items,
    });
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('archive-games-metadata-total').textContent,
    ).toMatch(/42/);
  });

  // ─── KS-2144: infinite scroll (sentinel + IntersectionObserver) ──
  it('KS-2144: первая страница → sentinel в DOM, конец списка не показан', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce({
      total: null,
      hasNext: true,
      nextCursor: 'C2',
      items: sampleResponse.items,
    });
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('archive-games-sentinel')).toBeInTheDocument();
    expect(screen.queryByTestId('archive-games-end')).toBeNull();
  });

  it('KS-2144: `nextCursor: null` → sentinel убран, видим «End of archive»', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce({
      total: null,
      hasNext: false,
      nextCursor: null,
      items: sampleResponse.items,
    });
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });

    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('archive-games-sentinel')).toBeNull();
    expect(screen.getByTestId('archive-games-end')).toBeInTheDocument();
  });

  it('KS-2144: дозагрузка через observer → items конкатятся, не replace', async () => {
    // Кастомный IntersectionObserver-mock через vi.stubGlobal —
    // happy-dom не имитирует viewport intersection, поэтому
    // подменяем глобал и сами триггерим callback. `class` нужен
    // потому что компонент вызывает `new IntersectionObserver(cb)`.
    const observerCallbacks: Array<
      (entries: Array<{ isIntersecting: boolean }>) => void
    > = [];
    class FakeIO {
      cb: (entries: Array<{ isIntersecting: boolean }>) => void;
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        this.cb = cb;
        observerCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);

    try {
      // Page 1
      mockGetGamesMetadata.mockResolvedValueOnce({
        total: null,
        hasNext: true,
        nextCursor: 'C2',
        items: sampleResponse.items,
      });
      renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });
      await waitFor(() =>
        expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
      );
      // Sentinel зарегистрировал минимум один observer.
      expect(observerCallbacks.length).toBeGreaterThan(0);

      // Page 2 ответ — другая партия с id=g3.
      mockGetGamesMetadata.mockResolvedValueOnce({
        total: null,
        hasNext: false,
        nextCursor: null,
        items: [{ ...sampleResponse.items[0], id: 'g3' }],
      });

      // Триггерим callback — имитируем «sentinel попал в viewport».
      observerCallbacks.forEach((cb) => cb([{ isIntersecting: true }]));

      await waitFor(() =>
        expect(screen.getByTestId('archive-game-row-g3')).toBeInTheDocument(),
      );
      // items конкатенированы: g1 (страница 1) остался.
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument();
      // Cursor 'C2' из первой страницы передан во второй запрос.
      expect(mockGetGamesMetadata).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: 'C2', offset: undefined }),
        expect.anything(),
      );
      // nextCursor: null → end-of-archive.
      expect(screen.getByTestId('archive-games-end')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('KS-2144: смена sort → items очищаются, page=1 без cursor', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce({
      total: null,
      hasNext: true,
      nextCursor: 'C2',
      items: sampleResponse.items,
    });
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
    );

    mockGetGamesMetadata.mockResolvedValueOnce({
      total: null,
      hasNext: true,
      nextCursor: 'C2new',
      items: [{ ...sampleResponse.items[0], id: 'gx' }],
    });
    await user.selectOptions(
      screen.getByTestId('archive-metadata-filter-sort'),
      'topElo',
    );

    await waitFor(() =>
      expect(mockGetGamesMetadata).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sort: 'topElo',
          cursor: undefined,
          offset: 0,
        }),
        expect.anything(),
      ),
    );
    // Старая партия g1 пропала из списка (items очищены).
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-gx')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('archive-game-row-g1')).toBeNull();
  });

  it('KS-2144: deep-link `?cursor=abc` → запрос с этим cursor', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce({
      total: null,
      hasNext: true,
      nextCursor: 'C-next',
      items: sampleResponse.items,
    });
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games?page=2&cursor=abc',
    });
    await waitFor(() =>
      expect(mockGetGamesMetadata).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: 'abc', offset: undefined }),
        expect.anything(),
      ),
    );
  });

  it('KS-2144: deep-link `?page=3` без cursor → fallback offset=40', async () => {
    mockGetGamesMetadata.mockResolvedValueOnce({
      total: null,
      hasNext: true,
      nextCursor: 'C-next',
      items: sampleResponse.items,
    });
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games?page=3',
    });
    await waitFor(() =>
      expect(mockGetGamesMetadata).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 40, cursor: undefined }),
        expect.anything(),
      ),
    );
  });

  // KS-2143 Next/Prev/page-info тесты заменены на KS-2144 (infinite scroll выше).

  // ─── KS-2149: race-condition / dedup ─────────────────────────────
  it('KS-2149: inflight ответ от старого reqKey игнорируется при смене фильтра', async () => {
    // Готовим deferred promise для первой initial-загрузки. Не
    // резолвим, пока не сменим URL — имитируем «висящий запрос».
    let resolveInitialA: (v: unknown) => void = () => {};
    const initialAPromise = new Promise((r) => {
      resolveInitialA = r;
    });
    mockGetGamesMetadata.mockImplementationOnce(() => initialAPromise);

    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });

    // Меняем sort до прихода ответа A. После selectOptions URL
    // меняется, новый useEffect инкрементит seq, abort'ит controller A.
    mockGetGamesMetadata.mockResolvedValueOnce({
      total: null,
      hasNext: false,
      nextCursor: null,
      items: [{ ...sampleResponse.items[0], id: 'B1' }],
    });
    await user.selectOptions(
      screen.getByTestId('archive-metadata-filter-sort'),
      'topElo',
    );

    // Ответ B пришёл — на странице B1.
    await waitFor(() =>
      expect(screen.getByTestId('archive-game-row-B1')).toBeInTheDocument(),
    );

    // Резолвим устаревший A-ответ. Он должен быть проигнорирован
    // через seq-guard — items НЕ должны содержать A1.
    resolveInitialA({
      total: null,
      hasNext: false,
      nextCursor: null,
      items: [{ ...sampleResponse.items[0], id: 'A1' }],
    });
    // Дай React шанс прогнать .then() — ничего не должно произойти.
    await new Promise((r) => setTimeout(r, 30));

    expect(screen.queryByTestId('archive-game-row-A1')).toBeNull();
    expect(screen.getByTestId('archive-game-row-B1')).toBeInTheDocument();
  });

  it('KS-2149: dedup в loadMore — если ответ содержит уже виденный id, не дублируется', async () => {
    // Кастомный IntersectionObserver — сами триггерим callback.
    const observerCallbacks: Array<
      (entries: Array<{ isIntersecting: boolean }>) => void
    > = [];
    class FakeIO {
      cb: (entries: Array<{ isIntersecting: boolean }>) => void;
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        this.cb = cb;
        observerCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);

    try {
      // Page 1 с двумя items g1, g2 и nextCursor C2.
      mockGetGamesMetadata.mockResolvedValueOnce({
        total: null,
        hasNext: true,
        nextCursor: 'C2',
        items: sampleResponse.items, // g1, g2
      });
      renderWithProviders(<ArchiveGamesPage />, { route: '/archive/games' });
      await waitFor(() =>
        expect(screen.getByTestId('archive-game-row-g1')).toBeInTheDocument(),
      );

      // Page 2 — backend ошибочно отдал g1 ещё раз + новый g3.
      mockGetGamesMetadata.mockResolvedValueOnce({
        total: null,
        hasNext: false,
        nextCursor: null,
        items: [
          sampleResponse.items[0], // g1 (дубль)
          { ...sampleResponse.items[0], id: 'g3' },
        ],
      });
      observerCallbacks.forEach((cb) => cb([{ isIntersecting: true }]));

      await waitFor(() =>
        expect(screen.getByTestId('archive-game-row-g3')).toBeInTheDocument(),
      );

      // g1 должен быть один (не два) — dedup сработал.
      expect(screen.getAllByTestId('archive-game-row-g1')).toHaveLength(1);
      // g2 на месте, g3 добавлен.
      expect(screen.getByTestId('archive-game-row-g2')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
