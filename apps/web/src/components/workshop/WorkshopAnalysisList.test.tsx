/**
 * KS-2933 (Phase B3) — тесты применения saved-filter пресета через
 * новый SavedFiltersDropdown в Мастерской.
 *
 * Стратегия: моки `api` (списки анализов, saved-filters), мок
 * `AuthContext` (sсимуляция авторизованного пользователя), и тестовый
 * `LocationProbe`, который читает `location.search` из react-router'а
 * и кладёт его в DOM — это даёт детерминированную проверку, что
 * `updateUrl(...)` отработал после apply.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import type {
  AnalysisListItem,
  SavedFilterDto,
  SavedFilterParams,
} from '@kingside/shared';

import { renderWithProviders, screen } from '../../test/test-utils';
import { WorkshopAnalysisList } from './WorkshopAnalysisList';

vi.mock('../../api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'tester' },
    token: 'jwt',
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    loginWithTokens: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { api } from '../../api';

const mockedApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-probe">{loc.search}</div>;
}

function workshopParams(
  overrides: Partial<Extract<SavedFilterParams, { section: 'workshop' }>> = {},
): SavedFilterParams {
  return {
    section: 'workshop',
    category: null,
    tags: [],
    search: null,
    sortOrder: null,
    ...overrides,
  };
}

function workshopFilterDto(
  id: string,
  overrides: Partial<SavedFilterDto> = {},
): SavedFilterDto {
  return {
    id,
    section: 'workshop',
    name: `preset-${id}`,
    params: workshopParams(),
    createdAt: '2026-05-13T08:00:00.000Z',
    updatedAt: '2026-05-13T08:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // `/analyses` нужен компоненту для render'а основной части — отдадим пустой.
  // Конкретные тесты могут переопределить через `mockResolvedValueOnce`.
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Связывает мок `api.get` с разными URL'ами через одну функцию. */
function wireApiGet(handlers: {
  analyses?: AnalysisListItem[];
  savedFilters?: SavedFilterDto[];
}) {
  mockedApi.get.mockImplementation(async (path: string) => {
    if (path === '/analyses') return handlers.analyses ?? [];
    if (path === '/user/saved-filters?section=workshop')
      return handlers.savedFilters ?? [];
    if (path.startsWith('/analyses/search')) return [];
    return [];
  });
}

describe('WorkshopAnalysisList — KS-2933 (B3)', () => {
  it('старый блок чипов `.workshop-saved-filters` больше не рендерится', async () => {
    wireApiGet({});
    const { container } = renderWithProviders(<WorkshopAnalysisList />);
    await waitFor(() =>
      expect(
        screen.queryByTestId('saved-filters-dropdown'),
      ).toBeInTheDocument(),
    );
    // Старая разметка чипов и save-row не должна присутствовать.
    expect(
      container.querySelector('.workshop-saved-filters'),
    ).toBeNull();
    expect(
      container.querySelector('.workshop-save-filter-row'),
    ).toBeNull();
  });

  it('apply пресета через dropdown ставит filterValues и обновляет URL', async () => {
    const preset = workshopFilterDto('preset-1', {
      name: 'Puzzle e4 italian',
      params: workshopParams({
        category: 'puzzle',
        tags: ['italian', 'gambit'],
        search: 'e4',
      }),
    });
    wireApiGet({ savedFilters: [preset] });

    const user = userEvent.setup();
    renderWithProviders(
      <>
        <WorkshopAnalysisList />
        <LocationProbe />
      </>,
    );

    // Дожидаемся, пока useSavedFilters догрузит пресет.
    await waitFor(() =>
      expect(
        screen.getByTestId('saved-filters-toggle').textContent,
      ).toContain('(1)'),
    );

    // Открываем dropdown и применяем пресет.
    await user.click(screen.getByTestId('saved-filters-toggle'));
    await user.click(screen.getByTestId('saved-filters-apply-preset-1'));

    // URL обновлён — содержит все три поля пресета.
    await waitFor(() => {
      const search = screen.getByTestId('location-probe').textContent ?? '';
      expect(search).toContain('category=puzzle');
      expect(search).toContain('tags=italian%2Cgambit');
      expect(search).toContain('search=e4');
    });

    // Локальный стейт: activeCategoryTab=puzzle (button .active),
    // search-input value=e4. Tag-chips — отдельно: должны
    // присутствовать оба тега.
    await waitFor(() => {
      const activeTab = document.querySelector('.workshop-category-tab.active');
      expect(activeTab?.textContent).toMatch(/Puzzles/i);
    });
    const searchInput = document.querySelector<HTMLInputElement>(
      '.workshop-search input',
    );
    expect(searchInput?.value).toBe('e4');
    expect(document.body.textContent).toContain('italian');
    expect(document.body.textContent).toContain('gambit');
  });

  it('apply пресета с category=null ставит таб «All» и не пишет category в URL', async () => {
    const preset = workshopFilterDto('p2', {
      name: 'Free tag-italian',
      params: workshopParams({
        category: null,
        tags: ['italian'],
        search: null,
      }),
    });
    wireApiGet({ savedFilters: [preset] });

    const user = userEvent.setup();
    renderWithProviders(
      <>
        <WorkshopAnalysisList />
        <LocationProbe />
      </>,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('saved-filters-toggle').textContent,
      ).toContain('(1)'),
    );
    await user.click(screen.getByTestId('saved-filters-toggle'));
    await user.click(screen.getByTestId('saved-filters-apply-p2'));

    await waitFor(() => {
      const search = screen.getByTestId('location-probe').textContent ?? '';
      // category пропущен — null маппится в 'all', а 'all' в URL не пишется.
      expect(search).not.toContain('category=');
      expect(search).toContain('tags=italian');
      expect(search).not.toContain('search=');
    });

    // Активный таб — «All».
    const activeTab = document.querySelector('.workshop-category-tab.active');
    expect(activeTab?.textContent).toMatch(/^All/i);
  });
});
