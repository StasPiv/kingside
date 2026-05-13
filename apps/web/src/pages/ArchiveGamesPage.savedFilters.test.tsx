/**
 * KS-2924 / KS-2936 (Phase C1) — тесты интеграции SavedFiltersDropdown
 * в `ArchiveMetadataMode`.
 *
 * Покрытие:
 *   - сериализатор `archiveValuesToSavedParams` (нормализация
 *     `result='any' → null`, пустые строки → null, `sort='recent' → null`);
 *   - десериализатор `archiveSavedParamsToValues` (legacy `result='any'`,
 *     `sort=null`, фильтрация невалидных timeControlCategory);
 *   - end-to-end: apply пресета через dropdown пишет в URL (через
 *     `metadataFiltersToUrl`-эквивалент), сбрасывает пагинацию (`page=1`,
 *     без `cursor`), не ломает KS-2210 автосейв (вызвал
 *     `archivePreferencesApi.putFilters` с новыми значениями).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import type { SavedFilterDto } from '@kingside/shared';

import { renderWithProviders, screen } from '../test/test-utils';
import { ApiError } from '../ApiError';
import {
  ArchiveGamesPage,
  archiveValuesToSavedParams,
  archiveSavedParamsToValues,
  canonicalArchiveParams,
  findMatchingFilter,
  type ArchiveSavedFilterParams,
} from './ArchiveGamesPage';
import { EMPTY_METADATA_FILTERS } from '../components/archive/ArchiveMetadataFilters';

// ─── Моки сетевых модулей ────────────────────────────────────────────
const mockGetGamesMetadata = vi.fn();
const mockGetGameById = vi.fn();
vi.mock('../api/archive', () => ({
  archiveApi: {
    getArchiveGamesMetadata: (...args: unknown[]) =>
      mockGetGamesMetadata(...args),
    getArchiveGameById: (...args: unknown[]) => mockGetGameById(...args),
  },
}));

const mockPutFilters = vi.fn();
const mockGetPreferencesFilters = vi.fn();
vi.mock('../api/archivePreferencesApi', () => ({
  archivePreferencesApi: {
    getFilters: () => mockGetPreferencesFilters(),
    putFilters: (...args: unknown[]) => mockPutFilters(...args),
  },
}));

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPatch = vi.fn();
const mockApiDelete = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    delete: (...args: unknown[]) => mockApiDelete(...args),
  },
}));

// `ArchivePositionHeader` рендерит мини-доску через react-chessboard,
// которая в happy-dom падает. by-position-режим в этих тестах не
// нужен — заглушка.
vi.mock('../components/archive/ArchivePositionHeader', () => ({
  ArchivePositionHeader: () => <div />,
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

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return { ...actual, useNavigate: () => mockNavigate };
});

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-probe">{loc.search}</div>;
}

function archiveDto(
  id: string,
  overrides: Partial<SavedFilterDto> = {},
): SavedFilterDto {
  const baseParams: ArchiveSavedFilterParams = {
    section: 'archive',
    players: [],
    event: null,
    eco: null,
    result: null,
    minElo: null,
    since: null,
    until: null,
    minPly: null,
    maxPly: null,
    timeControlCategory: [],
    sort: null,
  };
  return {
    id,
    section: 'archive',
    name: `preset-${id}`,
    params: baseParams,
    createdAt: '2026-05-13T08:00:00.000Z',
    updatedAt: '2026-05-13T08:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // KS-2210 GET /user/preferences/archive-filters — отвечаем «пусто»,
  // чтобы не было restore'а который бы переписал URL.
  mockGetPreferencesFilters.mockResolvedValue({ filters: {} });
  mockPutFilters.mockResolvedValue(undefined);
  mockGetGamesMetadata.mockResolvedValue({
    items: [],
    total: 0,
    nextCursor: null,
  });
  // api.get используется в useSavedFilters; default — пустой список
  // saved-filters. Конкретные тесты переопределяют через
  // `mockApiGet.mockImplementationOnce`.
  mockApiGet.mockImplementation(async (path: string) => {
    if (path === '/user/saved-filters?section=archive') return [];
    return [];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Unit-тесты сериализаторов ───────────────────────────────────────

describe('archiveValuesToSavedParams — KS-2936', () => {
  it('пустые/дефолтные значения → null/[]', () => {
    const p = archiveValuesToSavedParams(EMPTY_METADATA_FILTERS);
    expect(p).toEqual<ArchiveSavedFilterParams>({
      section: 'archive',
      players: [],
      event: null,
      eco: null,
      result: null,
      minElo: null,
      since: null,
      until: null,
      minPly: null,
      maxPly: null,
      timeControlCategory: [],
      sort: null,
    });
  });

  it('result="any" → null; sort="recent" → null; пустые строки → null', () => {
    const p = archiveValuesToSavedParams({
      players: ['Carlsen'],
      event: '',
      eco: '',
      result: 'any',
      minElo: 2700,
      since: '',
      until: '',
      minPly: null,
      maxPly: null,
      sort: 'recent',
      timeControlCategory: [],
    });
    expect(p.result).toBeNull();
    expect(p.sort).toBeNull();
    expect(p.event).toBeNull();
    expect(p.eco).toBeNull();
    expect(p.since).toBeNull();
    expect(p.until).toBeNull();
    expect(p.players).toEqual(['Carlsen']);
    expect(p.minElo).toBe(2700);
  });

  it('result/sort/непустые поля сохраняются как есть', () => {
    const p = archiveValuesToSavedParams({
      players: ['Carlsen', 'Caruana'],
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
    });
    expect(p).toMatchObject({
      section: 'archive',
      players: ['Carlsen', 'Caruana'],
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
    });
  });

  it('массивы копируются по значению (нет shared reference)', () => {
    const players = ['A'];
    const tcc = ['blitz' as const];
    const p = archiveValuesToSavedParams({
      ...EMPTY_METADATA_FILTERS,
      players,
      timeControlCategory: tcc,
    });
    expect(p.players).not.toBe(players);
    expect(p.timeControlCategory).not.toBe(tcc);
  });
});

describe('archiveSavedParamsToValues — KS-2936', () => {
  it('null/пусто → EMPTY-эквивалент', () => {
    const v = archiveSavedParamsToValues({
      section: 'archive',
      players: [],
      event: null,
      eco: null,
      result: null,
      minElo: null,
      since: null,
      until: null,
      minPly: null,
      maxPly: null,
      timeControlCategory: [],
      sort: null,
    });
    expect(v).toEqual(EMPTY_METADATA_FILTERS);
  });

  it('legacy result="any" в params → result="any" в form', () => {
    const v = archiveSavedParamsToValues({
      section: 'archive',
      players: [],
      event: null,
      eco: null,
      result: 'any',
      minElo: null,
      since: null,
      until: null,
      minPly: null,
      maxPly: null,
      timeControlCategory: [],
      sort: null,
    });
    expect(v.result).toBe('any');
  });

  it('невалидный sort → "recent"; невалидные timeControlCategory отбрасываются', () => {
    const v = archiveSavedParamsToValues({
      section: 'archive',
      players: [],
      event: null,
      eco: null,
      result: null,
      minElo: null,
      since: null,
      until: null,
      minPly: null,
      maxPly: null,
      // @ts-expect-error — намеренно невалидные значения для теста.
      timeControlCategory: ['blitz', 'invalid'],
      // @ts-expect-error — невалидный sort.
      sort: 'unknown',
    });
    expect(v.timeControlCategory).toEqual(['blitz']);
    expect(v.sort).toBe('recent');
  });

  it('roundtrip values → params → values', () => {
    const original = {
      players: ['Carlsen'],
      event: 'Wijk',
      eco: 'B90',
      result: '1-0' as const,
      minElo: 2700,
      since: '2020-01-01',
      until: '',
      minPly: 20,
      maxPly: null,
      sort: 'topElo' as const,
      timeControlCategory: ['classical' as const],
    };
    const round = archiveSavedParamsToValues(
      archiveValuesToSavedParams(original),
    );
    expect(round).toEqual(original);
  });
});

// ─── Unit-тесты canonicalArchiveParams / findMatchingFilter (KS-2937) ─

describe('canonicalArchiveParams — KS-2937', () => {
  const base: ArchiveSavedFilterParams = {
    section: 'archive',
    players: [],
    event: null,
    eco: null,
    result: null,
    minElo: null,
    since: null,
    until: null,
    minPly: null,
    maxPly: null,
    timeControlCategory: [],
    sort: null,
  };

  it('идемпотентен: canonical(canonical(x)) ≡ canonical(x)', () => {
    const a = canonicalArchiveParams({
      ...base,
      players: ['B', '', 'A'],
      timeControlCategory: ['rapid', 'blitz'],
    });
    const b = canonicalArchiveParams(a);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('result="any" → null; sort="recent" → null', () => {
    const x = canonicalArchiveParams({
      ...base,
      result: 'any',
      sort: 'recent',
    });
    expect(x.result).toBeNull();
    expect(x.sort).toBeNull();
  });

  it('players и timeControlCategory сортируются + чистятся от пустых строк', () => {
    const x = canonicalArchiveParams({
      ...base,
      players: ['  Carlsen ', '', 'Aronian', 'Caruana'],
      timeControlCategory: ['rapid', 'blitz', 'classical'],
    });
    expect(x.players).toEqual(['Aronian', 'Carlsen', 'Caruana']);
    expect(x.timeControlCategory).toEqual(['blitz', 'classical', 'rapid']);
  });

  it('пустые строки event/eco/since/until → null', () => {
    const x = canonicalArchiveParams({
      ...base,
      event: '',
      eco: '',
      since: '',
      until: '',
    });
    expect(x.event).toBeNull();
    expect(x.eco).toBeNull();
    expect(x.since).toBeNull();
    expect(x.until).toBeNull();
  });
});

describe('findMatchingFilter — KS-2937', () => {
  const base: ArchiveSavedFilterParams = {
    section: 'archive',
    players: [],
    event: null,
    eco: null,
    result: null,
    minElo: null,
    since: null,
    until: null,
    minPly: null,
    maxPly: null,
    timeControlCategory: [],
    sort: null,
  };

  it('возвращает null если совпадений нет', () => {
    const dtos: SavedFilterDto[] = [
      archiveDto('a', { params: { ...base, eco: 'B90' } }),
    ];
    expect(findMatchingFilter({ ...base, eco: 'C20' }, dtos)).toBeNull();
  });

  it('возвращает id совпавшего пресета (точное совпадение)', () => {
    const dtos: SavedFilterDto[] = [
      archiveDto('a', { params: { ...base, eco: 'B90' } }),
      archiveDto('b', { params: { ...base, eco: 'C20' } }),
    ];
    expect(findMatchingFilter({ ...base, eco: 'C20' }, dtos)).toBe('b');
  });

  it('результат "any" в одной стороне и null в другой считаются равными', () => {
    const dtos: SavedFilterDto[] = [
      archiveDto('a', { params: { ...base, result: null } }),
    ];
    expect(findMatchingFilter({ ...base, result: 'any' }, dtos)).toBe('a');
  });

  it('sort="recent" в одной стороне и null в другой считаются равными', () => {
    const dtos: SavedFilterDto[] = [
      archiveDto('a', { params: { ...base, sort: null } }),
    ];
    expect(
      findMatchingFilter({ ...base, sort: 'recent' as const }, dtos),
    ).toBe('a');
  });

  it('порядок элементов в players/timeControlCategory не влияет', () => {
    const dtos: SavedFilterDto[] = [
      archiveDto('a', {
        params: {
          ...base,
          players: ['Carlsen', 'Aronian'],
          timeControlCategory: ['blitz', 'rapid'],
        },
      }),
    ];
    expect(
      findMatchingFilter(
        {
          ...base,
          players: ['Aronian', 'Carlsen'],
          timeControlCategory: ['rapid', 'blitz'],
        },
        dtos,
      ),
    ).toBe('a');
  });

  it('изменение одного поля → возвращает null', () => {
    const dtos: SavedFilterDto[] = [
      archiveDto('a', {
        params: { ...base, eco: 'B90', minElo: 2700 },
      }),
    ];
    expect(
      findMatchingFilter({ ...base, eco: 'B90', minElo: 2600 }, dtos),
    ).toBeNull();
  });

  it('пустой массив filters → null', () => {
    expect(findMatchingFilter({ ...base }, [])).toBeNull();
  });

  it('игнорирует filters другой секции', () => {
    // workshop-фильтр с теми же «пустыми» params не должен матчиться.
    const dtos: SavedFilterDto[] = [
      {
        id: 'w',
        section: 'workshop',
        name: 'workshop preset',
        params: {
          section: 'workshop',
          category: null,
          tags: [],
          search: null,
          sortOrder: null,
        },
        createdAt: '2026-05-13T00:00:00.000Z',
        updatedAt: '2026-05-13T00:00:00.000Z',
      },
    ];
    expect(findMatchingFilter({ ...base }, dtos)).toBeNull();
  });
});

// ─── Интеграционный тест ─────────────────────────────────────────────

describe('SavedFiltersDropdown в ArchiveMetadataMode — KS-2936 интеграция', () => {
  it('apply пресета → URL обновлён + pagination=1 без cursor + KS-2210 putFilters', async () => {
    const preset = archiveDto('carl-najdorf', {
      name: 'Carlsen Najdorf 2020+',
      params: {
        section: 'archive',
        players: ['Carlsen'],
        event: null,
        eco: 'B90',
        result: '1-0',
        minElo: 2700,
        since: '2020-01-01',
        until: null,
        minPly: 20,
        maxPly: null,
        timeControlCategory: ['classical'],
        sort: 'topElo',
      },
    });

    mockApiGet.mockImplementation(async (path: string) => {
      if (path === '/user/saved-filters?section=archive') return [preset];
      return [];
    });

    // Стартуем с URL'а где уже есть pagination (page=5, cursor=xyz) —
    // их apply должен сбросить.
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ArchiveGamesPage />
        <LocationProbe />
      </>,
      { route: '/archive/games?page=5&cursor=xyz' },
    );

    // Дожидаемся, что useSavedFilters догрузил пресет (тогл с (1)).
    await waitFor(() =>
      expect(
        screen.getByTestId('saved-filters-toggle').textContent,
      ).toContain('(1)'),
    );

    // Открываем dropdown и применяем пресет.
    await user.click(screen.getByTestId('saved-filters-toggle'));
    await user.click(screen.getByTestId('saved-filters-apply-carl-najdorf'));

    // URL обновился: все поля пресета записаны; pagination сброшена
    // (page и cursor отсутствуют).
    await waitFor(() => {
      const search = screen.getByTestId('location-probe').textContent ?? '';
      expect(search).toContain('player=Carlsen');
      expect(search).toContain('eco=B90');
      expect(search).toContain('result=1-0');
      expect(search).toContain('minElo=2700');
      expect(search).toContain('since=2020-01-01');
      expect(search).toContain('minPly=20');
      expect(search).toContain('sort=topElo');
      expect(search).toContain('timeControlCategory=classical');
      expect(search).not.toContain('page=');
      expect(search).not.toContain('cursor=');
    });

    // KS-2210: автосейв триггерится дебаунсом (1с). Используем
    // waitFor с увеличенным timeout, чтобы дождаться putFilters.
    await waitFor(
      () => {
        expect(mockPutFilters).toHaveBeenCalled();
        const lastCall =
          mockPutFilters.mock.calls[mockPutFilters.mock.calls.length - 1];
        expect(lastCall[0]).toMatchObject({
          player: 'Carlsen',
          eco: 'B90',
          result: '1-0',
          minElo: 2700,
          since: '2020-01-01',
          timeControl: 'classical',
          minPly: 20,
          sort: 'topElo',
        });
      },
      { timeout: 2000 },
    );
  });

  it('KS-2937 (C2): после apply пресет помечен чекмарком; после ручного изменения чекмарк пропадает; возврат точных значений возвращает чекмарк', async () => {
    const preset = archiveDto('p-active', {
      name: 'Eco B90',
      params: {
        section: 'archive',
        players: [],
        event: null,
        eco: 'B90',
        result: null,
        minElo: null,
        since: null,
        until: null,
        minPly: null,
        maxPly: null,
        timeControlCategory: [],
        sort: null,
      },
    });
    mockApiGet.mockImplementation(async (path: string) => {
      if (path === '/user/saved-filters?section=archive') return [preset];
      return [];
    });

    const user = userEvent.setup();
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games',
    });

    await waitFor(() =>
      expect(
        screen.getByTestId('saved-filters-toggle').textContent,
      ).toContain('(1)'),
    );

    // 1) Открываем dropdown, применяем пресет.
    await user.click(screen.getByTestId('saved-filters-toggle'));
    await user.click(screen.getByTestId('saved-filters-apply-p-active'));

    // 2) Открываем заново — строка пресета помечена чекмарком (activeFilterId).
    await user.click(screen.getByTestId('saved-filters-toggle'));
    await waitFor(() => {
      const row = screen.getByTestId('saved-filters-item-p-active');
      expect(
        row.querySelector('.saved-filters-dropdown__item-check'),
      ).not.toBeNull();
      expect(row.className).toContain(
        'saved-filters-dropdown__item--active',
      );
    });

    // 3) Меняем одно поле фильтра вручную (ECO → C20). Чекмарк
    //    пропадает, т.к. совпадение нарушено.
    //    Используем поле eco напрямую из формы. data-testid задан в
    //    ArchiveMetadataFilters через `testIdPrefix='archive-metadata-filter'`.
    // Закрываем popover перед взаимодействием с формой.
    await user.keyboard('{Escape}');
    const ecoInput = await screen.findByTestId(
      'archive-metadata-filter-eco',
    );
    await user.clear(ecoInput);
    await user.type(ecoInput, 'C20');
    // debounce 400ms на eco — подождём.
    await waitFor(
      () => {
        const row = screen.queryByTestId('saved-filters-item-p-active');
        // Открываем popover чтобы проверить состояние строки.
        if (!row) {
          // popover ещё закрыт.
          return;
        }
      },
      { timeout: 1000 },
    );
    // Снова открываем popover и проверяем что чекмарк ушёл.
    await user.click(screen.getByTestId('saved-filters-toggle'));
    await waitFor(() => {
      const row = screen.getByTestId('saved-filters-item-p-active');
      expect(
        row.querySelector('.saved-filters-dropdown__item-check'),
      ).toBeNull();
      expect(row.className).not.toContain(
        'saved-filters-dropdown__item--active',
      );
    });
  });

  it('currentParams нормализован: дефолтные values → params со всеми null', async () => {
    // Рендерим со «свежим» URL без фильтров. После загрузки toggle
    // отобразит «Save filter». Открываем popover — Save current →
    // POST должен пойти с params { все null / [] / sort=null }.
    mockApiGet.mockImplementation(async (path: string) => {
      if (path === '/user/saved-filters?section=archive') return [];
      return [];
    });
    mockApiPost.mockResolvedValue(
      archiveDto('new', { name: 'Empty preset' }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games',
    });

    await waitFor(() =>
      expect(screen.getByTestId('saved-filters-toggle').textContent).toBe(
        'Save filter',
      ),
    );

    await user.click(screen.getByTestId('saved-filters-toggle'));
    // KS-2932 §3: при N=0 click тогла автоматически открывает save-form.
    const input = await screen.findByTestId('saved-filters-save-input');
    await user.type(input, 'Empty preset');
    await user.click(screen.getByTestId('saved-filters-save-confirm'));

    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith(
        '/user/saved-filters',
        expect.objectContaining({
          section: 'archive',
          name: 'Empty preset',
          params: expect.objectContaining({
            section: 'archive',
            players: [],
            event: null,
            eco: null,
            result: null,
            minElo: null,
            since: null,
            until: null,
            minPly: null,
            maxPly: null,
            timeControlCategory: [],
            sort: null,
          }),
        }),
      ),
    );
  });

  it('KS-2938 §1: сохранение пресета через dropdown — POST на /user/saved-filters, новый пресет виден в списке', async () => {
    // Сценарий: пользователь зашёл с активными фильтрами в URL, открыл
    // dropdown, набрал имя, сохранил.
    mockApiGet.mockImplementation(async (path: string) => {
      if (path === '/user/saved-filters?section=archive') return [];
      return [];
    });
    const createdDto = archiveDto('saved-1', {
      name: 'My Najdorf',
      params: {
        section: 'archive',
        players: [],
        event: null,
        eco: 'B90',
        result: null,
        minElo: 2700,
        since: null,
        until: null,
        minPly: null,
        maxPly: null,
        timeControlCategory: [],
        sort: null,
      },
    });
    mockApiPost.mockResolvedValueOnce(createdDto);

    const user = userEvent.setup();
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games?eco=B90&minElo=2700',
    });

    // Тогл показывает «Save filter» (N=0). Клик откроет popover и
    // сразу активирует save-form.
    await waitFor(() =>
      expect(
        screen.getByTestId('saved-filters-toggle').textContent,
      ).toBe('Save filter'),
    );
    await user.click(screen.getByTestId('saved-filters-toggle'));
    const input = await screen.findByTestId('saved-filters-save-input');
    await user.type(input, 'My Najdorf');
    await user.click(screen.getByTestId('saved-filters-save-confirm'));

    // POST уходит с params на основе URL.
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith(
        '/user/saved-filters',
        expect.objectContaining({
          section: 'archive',
          name: 'My Najdorf',
          params: expect.objectContaining({
            eco: 'B90',
            minElo: 2700,
          }),
        }),
      ),
    );

    // После успеха пресет виден в списке + счётчик тогла=(1).
    await waitFor(() =>
      expect(
        screen.getByTestId('saved-filters-item-saved-1'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('saved-filters-toggle').textContent).toContain(
      '(1)',
    );
  });

  it('KS-2938 §2: apply пресета триггерит перезапрос архива с правильными query-params', async () => {
    const preset = archiveDto('p-refetch', {
      name: 'Carlsen 1-0',
      params: {
        section: 'archive',
        players: ['Carlsen'],
        event: null,
        eco: null,
        result: '1-0',
        minElo: null,
        since: null,
        until: null,
        minPly: null,
        maxPly: null,
        timeControlCategory: [],
        sort: null,
      },
    });
    mockApiGet.mockImplementation(async (path: string) => {
      if (path === '/user/saved-filters?section=archive') return [preset];
      return [];
    });

    const user = userEvent.setup();
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games',
    });

    // Дождёмся первого запроса архива.
    await waitFor(() =>
      expect(mockGetGamesMetadata).toHaveBeenCalled(),
    );
    const initialCalls = mockGetGamesMetadata.mock.calls.length;

    await waitFor(() =>
      expect(
        screen.getByTestId('saved-filters-toggle').textContent,
      ).toContain('(1)'),
    );
    await user.click(screen.getByTestId('saved-filters-toggle'));
    await user.click(screen.getByTestId('saved-filters-apply-p-refetch'));

    // После apply — новый запрос с player='Carlsen' и result='1-0'.
    await waitFor(() => {
      expect(mockGetGamesMetadata.mock.calls.length).toBeGreaterThan(
        initialCalls,
      );
    });
    const lastRequest =
      mockGetGamesMetadata.mock.calls[
        mockGetGamesMetadata.mock.calls.length - 1
      ][0];
    expect(lastRequest.player).toBe('Carlsen');
    expect(lastRequest.result).toBe('1-0');
    expect(lastRequest.offset).toBe(0);
    expect(lastRequest.cursor).toBeUndefined();
  });

  it('KS-2938 §4: deep-link фильтры имеют приоритет над автосейвом KS-2210', async () => {
    // Автосейв возвращает eco=A20, но URL содержит eco=B90 —
    // отображается B90 (restore-effect срабатывает только если URL
    // дефолтный).
    mockGetPreferencesFilters.mockResolvedValue({
      filters: {
        player: null,
        event: null,
        eco: 'A20',
        result: null,
        timeControl: null,
        minElo: null,
        since: null,
        until: null,
        minPly: null,
        maxPly: null,
        sort: null,
      },
    });

    renderWithProviders(
      <>
        <ArchiveGamesPage />
        <LocationProbe />
      </>,
      { route: '/archive/games?eco=B90' },
    );

    // Сначала ждём, что метадата-запрос ушёл (страница смонтирована).
    await waitFor(() => expect(mockGetGamesMetadata).toHaveBeenCalled());
    // Restore-effect выполнился (mockGetPreferencesFilters вызван),
    // но URL не должен поменяться — фильтр в URL уже не-дефолтный.
    await waitFor(() => {
      expect(mockGetPreferencesFilters).toHaveBeenCalled();
    });
    // Проверяем что URL остался с B90 (а не переписался на A20).
    const search = screen.getByTestId('location-probe').textContent ?? '';
    expect(search).toContain('eco=B90');
    expect(search).not.toContain('eco=A20');
  });

  it('KS-2938 §7: 21-й POST → toast про лимит, UI не блокируется', async () => {
    // У пользователя уже 20 пресетов — backend на 21-м вернёт 400.
    const existing = Array.from({ length: 20 }, (_, i) =>
      archiveDto(`f-${i}`, { name: `Filter ${i + 1}` }),
    );
    mockApiGet.mockImplementation(async (path: string) => {
      if (path === '/user/saved-filters?section=archive') return existing;
      return [];
    });
    mockApiPost.mockRejectedValueOnce(
      new ApiError('Maximum 20 saved filters per section', undefined, 400),
    );

    const user = userEvent.setup();
    renderWithProviders(<ArchiveGamesPage />, {
      route: '/archive/games?eco=B90',
    });

    await waitFor(() =>
      expect(
        screen.getByTestId('saved-filters-toggle').textContent,
      ).toContain('(20)'),
    );

    await user.click(screen.getByTestId('saved-filters-toggle'));
    await user.click(screen.getByTestId('saved-filters-save-btn'));
    const input = await screen.findByTestId('saved-filters-save-input');
    await user.type(input, '21st');
    await user.click(screen.getByTestId('saved-filters-save-confirm'));

    // Toast про лимит, dropdown не блокируется (всё ещё открыт +
    // save-form тоже).
    const toast = await screen.findByTestId('saved-filters-toast');
    expect(toast).toHaveAttribute('data-tone', 'error');
    expect(toast.textContent).toContain('20');
    expect(screen.getByTestId('saved-filters-popover')).toBeInTheDocument();
    expect(
      screen.getByTestId('saved-filters-save-form'),
    ).toBeInTheDocument();
  });
});
