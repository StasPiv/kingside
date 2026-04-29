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
        players: [],
        event: '',
        eco: '',
        sinceYear: '',
        untilYear: '',
        result: 'any',
        minElo: null,
        sort: 'recent',
        timeControlCategory: [],
      }),
    ).toBe('/archive/games');
  });

  it('KS-2084: несколько игроков → несколько ?player=', () => {
    const url = __buildSearchUrl({
      players: ['Carlsen,M', 'Caruana,F'],
      event: '',
      eco: '',
      sinceYear: '',
      untilYear: '',
      result: 'any',
      minElo: null,
      sort: 'recent',
      timeControlCategory: [],
    });
    const u = new URL(url, 'http://localhost');
    expect(u.searchParams.getAll('player')).toEqual(['Carlsen,M', 'Caruana,F']);
  });

  it('заполненная форма → URL c фильтрами и преобразованием годов', () => {
    const url = __buildSearchUrl({
      players: ['Carlsen'],
      event: 'Wijk aan Zee',
      eco: 'b90',
      sinceYear: '2020',
      untilYear: '2024',
      result: '1-0',
      minElo: 2700,
      sort: 'topElo',
      timeControlCategory: [],
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

  it('KS-2122: timeControlCategory массивом → дубликаты ?timeControlCategory', () => {
    const url = __buildSearchUrl({
      players: [],
      event: '',
      eco: '',
      sinceYear: '',
      untilYear: '',
      result: 'any',
      minElo: null,
      sort: 'recent',
      timeControlCategory: ['classical', 'rapid'],
    });
    const u = new URL(url, 'http://localhost');
    expect(u.searchParams.getAll('timeControlCategory')).toEqual([
      'classical',
      'rapid',
    ]);
  });

  it('KS-2122: пустой timeControlCategory не добавляется в query', () => {
    const url = __buildSearchUrl({
      players: [],
      event: '',
      eco: '',
      sinceYear: '',
      untilYear: '',
      result: 'any',
      minElo: null,
      sort: 'recent',
      timeControlCategory: [],
    });
    const u = new URL(url, 'http://localhost');
    expect(u.searchParams.getAll('timeControlCategory')).toEqual([]);
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

  it('KS-2122: клик по «Классика» + Submit → ?timeControlCategory=classical', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });

    await user.click(
      screen.getByTestId('archive-search-form-time-control-classical'),
    );
    await user.click(screen.getByTestId('archive-search-form-submit'));

    const arg = mockNavigate.mock.calls[0][0] as string;
    const u = new URL(arg, 'http://localhost');
    expect(u.searchParams.getAll('timeControlCategory')).toEqual([
      'classical',
    ]);
  });

  it('KS-2122: повторный клик по той же категории снимает её', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });

    const classical = screen.getByTestId(
      'archive-search-form-time-control-classical',
    );
    await user.click(classical);
    await user.click(classical);
    await user.click(screen.getByTestId('archive-search-form-submit'));

    const arg = mockNavigate.mock.calls[0][0] as string;
    const u = new URL(arg, 'http://localhost');
    expect(u.searchParams.getAll('timeControlCategory')).toEqual([]);
  });

  it('KS-2122: Reset очищает выбранную категорию', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });

    await user.click(
      screen.getByTestId('archive-search-form-time-control-classical'),
    );
    await user.click(screen.getByTestId('archive-search-form-reset'));
    await user.click(screen.getByTestId('archive-search-form-submit'));

    const arg = mockNavigate.mock.calls[0][0] as string;
    expect(arg).toBe('/archive/games');
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
    // KS-2084: после выбора игрок становится chip'ом, draft input
    // очищается — чтобы можно было сразу искать второго игрока.
    expect((input as HTMLInputElement).value).toBe('');
    expect(
      screen.getByTestId('archive-search-form-player-chip-Magnus Carlsen'),
    ).toBeInTheDocument();
  });

  it('KS-2084: можно добавить двух игроков → submit формирует ?player=A&player=B', async () => {
    mockApi.searchArchivePlayers
      .mockResolvedValueOnce({
        total: 1,
        items: [
          { name: 'Magnus Carlsen', slug: 'magnus-carlsen', gamesCount: 4500, peakElo: 2882 },
        ],
      })
      .mockResolvedValueOnce({
        total: 1,
        items: [
          { name: 'Fabiano Caruana', slug: 'fabiano-caruana', gamesCount: 3500, peakElo: 2844 },
        ],
      });
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });
    const input = screen.getByTestId('archive-player-autocomplete-input');

    // Первый игрок — выбор из dropdown'а.
    await user.type(input, 'Ma');
    await waitFor(() =>
      expect(
        screen.getByTestId('archive-player-autocomplete-item-magnus-carlsen'),
      ).toBeInTheDocument(),
    );
    await user.click(
      screen.getByTestId('archive-player-autocomplete-item-magnus-carlsen'),
    );

    // Второй игрок — выбор из dropdown'а.
    await user.type(input, 'Cr');
    await waitFor(() =>
      expect(
        screen.getByTestId('archive-player-autocomplete-item-fabiano-caruana'),
      ).toBeInTheDocument(),
    );
    await user.click(
      screen.getByTestId('archive-player-autocomplete-item-fabiano-caruana'),
    );

    // Оба chip'а в форме.
    expect(
      screen.getByTestId('archive-search-form-player-chip-Magnus Carlsen'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('archive-search-form-player-chip-Fabiano Caruana'),
    ).toBeInTheDocument();

    // Submit → navigate с двумя ?player=...
    await user.click(screen.getByTestId('archive-search-form-submit'));
    const arg = mockNavigate.mock.calls[0][0] as string;
    const u = new URL(arg, 'http://localhost');
    expect(u.searchParams.getAll('player')).toEqual([
      'Magnus Carlsen',
      'Fabiano Caruana',
    ]);
  });

  it('KS-2092: Enter в input при пустом dropdown → имя становится chip-ом', async () => {
    // searchArchivePlayers возвращает пустой список — dropdown не
    // подсветит ни одного item'а, activeIdx остаётся -1.
    mockApi.searchArchivePlayers.mockResolvedValue({ total: 0, items: [] });
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });
    const input = screen.getByTestId(
      'archive-player-autocomplete-input',
    ) as HTMLInputElement;

    await user.type(input, 'Каспаров');
    // Дождёмся, чтобы debounce-fetch отстрелял (иначе Enter в input
    // может произойти до setOpen(true) и handleKeyDown вернётся
    // раньше времени).
    await waitFor(() =>
      expect(mockApi.searchArchivePlayers).toHaveBeenCalledWith('Каспаров', 10),
    );
    await user.keyboard('{Enter}');

    // raw-значение из input ушло наверх как chip; input очистился.
    expect(
      screen.getByTestId('archive-search-form-player-chip-Каспаров'),
    ).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('KS-2092: submit с непустым draft (без явного Enter/выбора) → draft уезжает в ?player=', async () => {
    mockApi.searchArchivePlayers.mockResolvedValue({ total: 0, items: [] });
    const user = (await import('@testing-library/user-event')).default.setup();

    renderWithProviders(<ArchiveLobbyPage />, { route: '/archive' });
    const input = screen.getByTestId('archive-player-autocomplete-input');

    await user.type(input, 'Карпов');
    // НЕ жмём Enter — сразу submit. Форма должна сама подхватить draft.
    await user.click(screen.getByTestId('archive-search-form-submit'));
    const arg = mockNavigate.mock.calls[0][0] as string;
    const u = new URL(arg, 'http://localhost');
    expect(u.searchParams.getAll('player')).toEqual(['Карпов']);
  });
});
