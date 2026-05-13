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
import {
  ArchiveGamesPage,
  archiveValuesToSavedParams,
  archiveSavedParamsToValues,
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
});
