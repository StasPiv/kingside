/**
 * KS-2924 / KS-2931 Phase B1 — unit-тесты `useSavedFilters`.
 *
 * Покрытие (Acceptance):
 *   - GET по section при mount + сетевая ошибка → `error`;
 *   - optimistic create + успех (real id заменяет temp);
 *   - 409 на create → `SavedFiltersError('duplicate_name')`, откат;
 *   - 400 на create → `SavedFiltersError('limit_reached')`, откат;
 *   - optimistic rename + откат при сбое (восстановление имени);
 *   - optimistic update params + откат;
 *   - optimistic remove + откат (запись возвращается на исходную позицию);
 *   - workshop-миграция: legacy CSV+'all'→null, POST + removeItem;
 *   - миграция пропускается, если БД непустая (но legacy-ключ удаляется);
 *   - миграция пропускается, если legacy-ключ пуст;
 *   - archive-секция миграцию НЕ выполняет.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type {
  CreateSavedFilterPayload,
  SavedFilterDto,
  SavedFilterParams,
} from '@kingside/shared';

import { ApiError } from '../ApiError';
import {
  LS_LEGACY_WORKSHOP_KEY,
  SavedFiltersError,
  useSavedFilters,
} from './useSavedFilters';

vi.mock('../api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../api';

const mockedApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function workshopDto(
  id: string,
  overrides: Partial<SavedFilterDto> = {},
): SavedFilterDto {
  const baseParams: SavedFilterParams = {
    section: 'workshop',
    category: null,
    tags: [],
    search: null,
    sortOrder: null,
  };
  return {
    id,
    section: 'workshop',
    name: `filter-${id}`,
    params: baseParams,
    createdAt: '2026-05-13T08:00:00.000Z',
    updatedAt: '2026-05-13T08:00:00.000Z',
    ...overrides,
  };
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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('useSavedFilters — KS-2931', () => {
  describe('load', () => {
    it('GET /user/saved-filters?section=workshop при mount, заполняет filters', async () => {
      const dto = workshopDto('a');
      mockedApi.get.mockResolvedValueOnce([dto]);

      const { result } = renderHook(() => useSavedFilters('workshop'));
      expect(result.current.loading).toBe(true);
      expect(result.current.filters).toEqual([]);

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockedApi.get).toHaveBeenCalledWith(
        '/user/saved-filters?section=workshop',
      );
      expect(result.current.filters).toEqual([dto]);
      expect(result.current.error).toBeNull();
    });

    it('сетевая ошибка → error выставлен, loading=false', async () => {
      mockedApi.get.mockRejectedValueOnce(
        new ApiError('boom', 'NETWORK_ERROR', 0),
      );
      const { result } = renderHook(() => useSavedFilters('archive'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBe('boom');
      expect(result.current.filters).toEqual([]);
    });
  });

  describe('create', () => {
    it('optimistic-add + replace на real id при успехе', async () => {
      mockedApi.get.mockResolvedValueOnce([]);
      const real = workshopDto('real-1', { name: 'Spanish' });
      // Чуть-чуть задерживаем POST, чтобы поймать optimistic-фазу.
      mockedApi.post.mockImplementationOnce(
        () =>
          new Promise<SavedFilterDto>((res) =>
            setTimeout(() => res(real), 10),
          ),
      );

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let createPromise!: Promise<SavedFilterDto>;
      act(() => {
        createPromise = result.current.create('Spanish', workshopParams());
      });
      // Optimistic виден сразу.
      expect(result.current.filters).toHaveLength(1);
      expect(result.current.filters[0].id.startsWith('__optimistic_')).toBe(
        true,
      );
      expect(result.current.filters[0].name).toBe('Spanish');

      await act(async () => {
        await createPromise;
      });
      expect(mockedApi.post).toHaveBeenCalledWith(
        '/user/saved-filters',
        expect.objectContaining<CreateSavedFilterPayload>({
          section: 'workshop',
          name: 'Spanish',
          params: workshopParams(),
        }),
      );
      expect(result.current.filters).toHaveLength(1);
      expect(result.current.filters[0].id).toBe('real-1');
    });

    it('409 → SavedFiltersError("duplicate_name"), optimistic откатывается', async () => {
      mockedApi.get.mockResolvedValueOnce([]);
      mockedApi.post.mockRejectedValueOnce(
        new ApiError('Имя уже используется', undefined, 409),
      );

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(
        result.current.create('Dup', workshopParams()),
      ).rejects.toMatchObject({
        name: 'SavedFiltersError',
        code: 'duplicate_name',
      });
      // Optimistic-запись удалена.
      expect(result.current.filters).toEqual([]);
    });

    it('400 → SavedFiltersError("limit_reached"), откат', async () => {
      mockedApi.get.mockResolvedValueOnce([workshopDto('a')]);
      mockedApi.post.mockRejectedValueOnce(
        new ApiError('Maximum 20 saved filters per section', undefined, 400),
      );

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.create('21st', workshopParams());
        } catch (e) {
          caught = e;
        }
      });
      expect(caught).toBeInstanceOf(SavedFiltersError);
      expect((caught as SavedFiltersError).code).toBe('limit_reached');
      expect(result.current.filters).toHaveLength(1);
      expect(result.current.filters[0].id).toBe('a');
    });

    it('нераспознанный статус (500) пробрасывается как есть', async () => {
      mockedApi.get.mockResolvedValueOnce([]);
      const apiErr = new ApiError('Server error', undefined, 500);
      mockedApi.post.mockRejectedValueOnce(apiErr);

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(
        result.current.create('X', workshopParams()),
      ).rejects.toBe(apiErr);
      expect(result.current.filters).toEqual([]);
    });
  });

  describe('rename', () => {
    it('optimistic-переименование, PATCH с правильным телом', async () => {
      mockedApi.get.mockResolvedValueOnce([workshopDto('a', { name: 'Old' })]);
      mockedApi.patch.mockResolvedValueOnce(
        workshopDto('a', { name: 'New' }),
      );

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.rename('a', 'New');
      });
      expect(mockedApi.patch).toHaveBeenCalledWith(
        '/user/saved-filters/a',
        { name: 'New' },
      );
      expect(result.current.filters[0].name).toBe('New');
    });

    it('409 на rename → откат к старому имени + SavedFiltersError', async () => {
      mockedApi.get.mockResolvedValueOnce([
        workshopDto('a', { name: 'Original' }),
      ]);
      mockedApi.patch.mockRejectedValueOnce(
        new ApiError('Имя уже используется', undefined, 409),
      );

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(
        result.current.rename('a', 'Conflict'),
      ).rejects.toMatchObject({
        name: 'SavedFiltersError',
        code: 'duplicate_name',
      });
      expect(result.current.filters[0].name).toBe('Original');
    });
  });

  describe('update', () => {
    it('optimistic-обновление params, PATCH с телом { params }', async () => {
      const before = workshopDto('a', {
        params: workshopParams({ search: 'old' }),
      });
      mockedApi.get.mockResolvedValueOnce([before]);
      const after = workshopDto('a', {
        params: workshopParams({ search: 'new' }),
      });
      mockedApi.patch.mockResolvedValueOnce(after);

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.update('a', workshopParams({ search: 'new' }));
      });
      expect(mockedApi.patch).toHaveBeenCalledWith(
        '/user/saved-filters/a',
        { params: workshopParams({ search: 'new' }) },
      );
      const p = result.current.filters[0].params as Extract<
        SavedFilterParams,
        { section: 'workshop' }
      >;
      expect(p.search).toBe('new');
    });

    it('400 на update → откат params', async () => {
      const before = workshopDto('a', {
        params: workshopParams({ search: 'kept' }),
      });
      mockedApi.get.mockResolvedValueOnce([before]);
      mockedApi.patch.mockRejectedValueOnce(
        new ApiError('bad', undefined, 400),
      );

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(
        result.current.update('a', workshopParams({ search: 'broken' })),
      ).rejects.toMatchObject({ code: 'limit_reached' });
      const p = result.current.filters[0].params as Extract<
        SavedFilterParams,
        { section: 'workshop' }
      >;
      expect(p.search).toBe('kept');
    });
  });

  describe('remove', () => {
    it('optimistic-remove + DELETE; при успехе запись не возвращается', async () => {
      mockedApi.get.mockResolvedValueOnce([
        workshopDto('a'),
        workshopDto('b'),
      ]);
      mockedApi.delete.mockResolvedValueOnce({ deleted: true });

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.remove('a');
      });
      expect(mockedApi.delete).toHaveBeenCalledWith('/user/saved-filters/a');
      expect(result.current.filters.map((f) => f.id)).toEqual(['b']);
    });

    it('откат при ошибке — запись возвращается на исходную позицию', async () => {
      mockedApi.get.mockResolvedValueOnce([
        workshopDto('a'),
        workshopDto('b'),
        workshopDto('c'),
      ]);
      mockedApi.delete.mockRejectedValueOnce(
        new ApiError('boom', undefined, 500),
      );

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(result.current.remove('b')).rejects.toBeInstanceOf(
        ApiError,
      );
      // b восстановлен на индекс 1.
      expect(result.current.filters.map((f) => f.id)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });
  });

  describe('workshop migration', () => {
    it('БД пустая + legacy в LS → POST на каждый, removeItem, filters содержат мигрированные', async () => {
      mockedApi.get.mockResolvedValueOnce([]);
      // Сохраняем legacy в формате с CSV-tags и 'all'-category.
      localStorage.setItem(
        LS_LEGACY_WORKSHOP_KEY,
        JSON.stringify([
          {
            name: 'Italian',
            category: 'opening',
            tags: ['italian', 'gambit'],
            search: 'e4',
          },
          {
            name: 'CSV-form',
            category: 'all',
            tags: 'a, b ,c',
            search: '',
          },
        ]),
      );
      mockedApi.post
        .mockResolvedValueOnce(
          workshopDto('m1', {
            name: 'Italian',
            params: workshopParams({
              category: 'opening',
              tags: ['italian', 'gambit'],
              search: 'e4',
            }),
          }),
        )
        .mockResolvedValueOnce(
          workshopDto('m2', {
            name: 'CSV-form',
            params: workshopParams({ tags: ['a', 'b', 'c'] }),
          }),
        );

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      // Два POST'а с правильно нормализованным payload'ом.
      expect(mockedApi.post).toHaveBeenCalledTimes(2);
      expect(mockedApi.post).toHaveBeenNthCalledWith(
        1,
        '/user/saved-filters',
        expect.objectContaining({
          section: 'workshop',
          name: 'Italian',
          params: workshopParams({
            category: 'opening',
            tags: ['italian', 'gambit'],
            search: 'e4',
          }),
        }),
      );
      expect(mockedApi.post).toHaveBeenNthCalledWith(
        2,
        '/user/saved-filters',
        expect.objectContaining({
          section: 'workshop',
          name: 'CSV-form',
          // category 'all' → null, search '' → null, tags по CSV.
          params: workshopParams({ tags: ['a', 'b', 'c'] }),
        }),
      );
      // Legacy-ключ очищен.
      expect(localStorage.getItem(LS_LEGACY_WORKSHOP_KEY)).toBeNull();
      // В filters попали мигрированные.
      expect(result.current.filters.map((f) => f.id)).toEqual(['m1', 'm2']);
    });

    it('БД непустая → миграция пропускается, ключ всё равно удаляется', async () => {
      mockedApi.get.mockResolvedValueOnce([workshopDto('existing')]);
      localStorage.setItem(
        LS_LEGACY_WORKSHOP_KEY,
        JSON.stringify([{ name: 'X', category: 'all', tags: [], search: '' }]),
      );

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(mockedApi.post).not.toHaveBeenCalled();
      expect(localStorage.getItem(LS_LEGACY_WORKSHOP_KEY)).toBeNull();
      expect(result.current.filters.map((f) => f.id)).toEqual(['existing']);
    });

    it('legacy-ключ отсутствует → миграция пропускается, ошибок нет', async () => {
      mockedApi.get.mockResolvedValueOnce([]);
      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockedApi.post).not.toHaveBeenCalled();
      expect(result.current.filters).toEqual([]);
      expect(result.current.error).toBeNull();
    });

    it('archive-секция не выполняет миграцию даже при наличии legacy-ключа', async () => {
      mockedApi.get.mockResolvedValueOnce([]);
      localStorage.setItem(
        LS_LEGACY_WORKSHOP_KEY,
        JSON.stringify([{ name: 'X', category: 'all', tags: [], search: '' }]),
      );

      renderHook(() => useSavedFilters('archive'));
      await waitFor(() =>
        expect(mockedApi.get).toHaveBeenCalledWith(
          '/user/saved-filters?section=archive',
        ),
      );
      // Никаких POST + ключ остался для будущей workshop-сессии.
      expect(mockedApi.post).not.toHaveBeenCalled();
      expect(localStorage.getItem(LS_LEGACY_WORKSHOP_KEY)).not.toBeNull();
    });

    it('частичный сбой миграции (1 из 2 POST падает) — успешные остаются, ключ удаляется', async () => {
      mockedApi.get.mockResolvedValueOnce([]);
      localStorage.setItem(
        LS_LEGACY_WORKSHOP_KEY,
        JSON.stringify([
          { name: 'ok', category: 'opening', tags: [], search: '' },
          { name: 'bad', category: 'opening', tags: [], search: '' },
        ]),
      );
      mockedApi.post
        .mockResolvedValueOnce(workshopDto('ok-id', { name: 'ok' }))
        .mockRejectedValueOnce(new ApiError('boom', undefined, 500));

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.filters.map((f) => f.id)).toEqual(['ok-id']);
      expect(localStorage.getItem(LS_LEGACY_WORKSHOP_KEY)).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('повреждённый JSON в legacy-ключе → без падения, ключ удаляется', async () => {
      mockedApi.get.mockResolvedValueOnce([]);
      localStorage.setItem(LS_LEGACY_WORKSHOP_KEY, '{not-json');

      const { result } = renderHook(() => useSavedFilters('workshop'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(mockedApi.post).not.toHaveBeenCalled();
      expect(localStorage.getItem(LS_LEGACY_WORKSHOP_KEY)).toBeNull();
      expect(result.current.error).toBeNull();
    });
  });

  // ─── KS-2944: guest-режим + миграция при логине ─────────────────────
  describe('guest mode (KS-2944)', () => {
    const GUEST_ARCHIVE_KEY = 'savedFilters:archive';
    const GUEST_WORKSHOP_KEY = 'savedFilters:workshop';

    function archiveGuestParams(
      overrides: Partial<Extract<SavedFilterParams, { section: 'archive' }>> = {},
    ): SavedFilterParams {
      return {
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
        ...overrides,
      };
    }

    it('initial load: читает из LS, isGuestMode=true, api.get не вызывается', async () => {
      const seed = [
        {
          id: 'local-1',
          section: 'archive',
          name: 'A',
          params: archiveGuestParams({ eco: 'B90' }),
          createdAt: '2026-05-13T00:00:00.000Z',
          updatedAt: '2026-05-13T00:00:00.000Z',
        },
      ];
      localStorage.setItem(GUEST_ARCHIVE_KEY, JSON.stringify(seed));

      const { result } = renderHook(() =>
        useSavedFilters('archive', { isGuest: true }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.isGuestMode).toBe(true);
      expect(result.current.filters.map((f) => f.id)).toEqual(['local-1']);
      expect(mockedApi.get).not.toHaveBeenCalled();
    });

    it('create: пишет в LS с локальным id и persist между mounts', async () => {
      const { result, unmount } = renderHook(() =>
        useSavedFilters('archive', { isGuest: true }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.create('My filter', archiveGuestParams({ eco: 'B90' }));
      });
      expect(result.current.filters).toHaveLength(1);
      expect(result.current.filters[0].id.startsWith('local-')).toBe(true);
      expect(result.current.filters[0].name).toBe('My filter');

      // Persist: после ре-mount запись подгружается из LS.
      unmount();
      const { result: r2 } = renderHook(() =>
        useSavedFilters('archive', { isGuest: true }),
      );
      await waitFor(() => expect(r2.current.loading).toBe(false));
      expect(r2.current.filters.map((f) => f.name)).toEqual(['My filter']);
    });

    it('create: лимит 20 на guest → SavedFiltersError("limit_reached")', async () => {
      const existing = Array.from({ length: 20 }, (_, i) => ({
        id: `local-${i}`,
        section: 'archive',
        name: `Filter ${i}`,
        params: archiveGuestParams(),
        createdAt: '2026-05-13T00:00:00.000Z',
        updatedAt: '2026-05-13T00:00:00.000Z',
      }));
      localStorage.setItem(GUEST_ARCHIVE_KEY, JSON.stringify(existing));

      const { result } = renderHook(() =>
        useSavedFilters('archive', { isGuest: true }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(
        result.current.create('21st', archiveGuestParams()),
      ).rejects.toMatchObject({
        name: 'SavedFiltersError',
        code: 'limit_reached',
      });
      expect(result.current.filters).toHaveLength(20);
    });

    it('create: дубль имени → SavedFiltersError("duplicate_name")', async () => {
      const seed = [
        {
          id: 'local-a',
          section: 'archive',
          name: 'Dup',
          params: archiveGuestParams(),
          createdAt: '2026-05-13T00:00:00.000Z',
          updatedAt: '2026-05-13T00:00:00.000Z',
        },
      ];
      localStorage.setItem(GUEST_ARCHIVE_KEY, JSON.stringify(seed));

      const { result } = renderHook(() =>
        useSavedFilters('archive', { isGuest: true }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(
        result.current.create('Dup', archiveGuestParams()),
      ).rejects.toMatchObject({
        name: 'SavedFiltersError',
        code: 'duplicate_name',
      });
      expect(result.current.filters).toHaveLength(1);
    });

    it('rename/update/remove работают в LS', async () => {
      const { result } = renderHook(() =>
        useSavedFilters('archive', { isGuest: true }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));

      // create → rename → update → remove
      let createdId = '';
      await act(async () => {
        const dto = await result.current.create('Initial', archiveGuestParams());
        createdId = dto.id;
      });
      expect(result.current.filters[0].name).toBe('Initial');

      await act(async () => {
        await result.current.rename(createdId, 'Renamed');
      });
      expect(result.current.filters[0].name).toBe('Renamed');

      await act(async () => {
        await result.current.update(createdId, archiveGuestParams({ eco: 'C20' }));
      });
      const p = result.current.filters[0].params as Extract<
        SavedFilterParams,
        { section: 'archive' }
      >;
      expect(p.eco).toBe('C20');

      await act(async () => {
        await result.current.remove(createdId);
      });
      expect(result.current.filters).toHaveLength(0);
      // LS — пустой массив (writeGuestFilters записал []).
      const stored = JSON.parse(
        localStorage.getItem(GUEST_ARCHIVE_KEY) ?? '[]',
      );
      expect(stored).toEqual([]);
    });

    it('rename: дубль имени в LS → duplicate_name', async () => {
      const seed = [
        {
          id: 'local-a',
          section: 'archive',
          name: 'First',
          params: archiveGuestParams(),
          createdAt: '2026-05-13T00:00:00.000Z',
          updatedAt: '2026-05-13T00:00:00.000Z',
        },
        {
          id: 'local-b',
          section: 'archive',
          name: 'Second',
          params: archiveGuestParams(),
          createdAt: '2026-05-13T00:00:00.000Z',
          updatedAt: '2026-05-13T00:00:00.000Z',
        },
      ];
      localStorage.setItem(GUEST_ARCHIVE_KEY, JSON.stringify(seed));

      const { result } = renderHook(() =>
        useSavedFilters('archive', { isGuest: true }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(
        result.current.rename('local-b', 'First'),
      ).rejects.toMatchObject({ code: 'duplicate_name' });
    });

    it('изоляция по section: archive не виден в workshop', async () => {
      localStorage.setItem(
        GUEST_ARCHIVE_KEY,
        JSON.stringify([
          {
            id: 'local-arc',
            section: 'archive',
            name: 'Arc',
            params: archiveGuestParams(),
            createdAt: '2026-05-13T00:00:00.000Z',
            updatedAt: '2026-05-13T00:00:00.000Z',
          },
        ]),
      );
      const { result } = renderHook(() =>
        useSavedFilters('workshop', { isGuest: true }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.filters).toEqual([]);
      // Записываем в workshop — archive не трогается.
      await act(async () => {
        await result.current.create('W', {
          section: 'workshop',
          category: null,
          tags: [],
          search: null,
          sortOrder: null,
        });
      });
      expect(
        JSON.parse(localStorage.getItem(GUEST_WORKSHOP_KEY) ?? '[]'),
      ).toHaveLength(1);
      expect(
        JSON.parse(localStorage.getItem(GUEST_ARCHIVE_KEY) ?? '[]'),
      ).toHaveLength(1);
    });

    it('повреждённый JSON в LS → пустой массив, без падения', async () => {
      localStorage.setItem(GUEST_ARCHIVE_KEY, '{not-json');
      const { result } = renderHook(() =>
        useSavedFilters('archive', { isGuest: true }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.filters).toEqual([]);
      expect(result.current.error).toBeNull();
    });
  });

  describe('migration guest → auth on login (KS-2944)', () => {
    const GUEST_ARCHIVE_KEY = 'savedFilters:archive';

    function makeGuestArchiveDto(
      id: string,
      name: string,
    ): SavedFilterDto {
      return {
        id,
        section: 'archive',
        name,
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
        createdAt: '2026-05-13T00:00:00.000Z',
        updatedAt: '2026-05-13T00:00:00.000Z',
      };
    }

    it('все POST успешно → LS очищен, filters из server-ответа', async () => {
      const a = makeGuestArchiveDto('local-a', 'A');
      const b = makeGuestArchiveDto('local-b', 'B');
      localStorage.setItem(GUEST_ARCHIVE_KEY, JSON.stringify([a, b]));

      mockedApi.post
        .mockResolvedValueOnce({ ...a, id: 'srv-a' })
        .mockResolvedValueOnce({ ...b, id: 'srv-b' });
      mockedApi.get.mockResolvedValueOnce([
        { ...a, id: 'srv-a' },
        { ...b, id: 'srv-b' },
      ]);

      // Стартуем с isGuest=true, потом переключаем на false (логин).
      const { result, rerender } = renderHook(
        ({ guest }: { guest: boolean }) =>
          useSavedFilters('archive', { isGuest: guest }),
        { initialProps: { guest: true } },
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      // Logged in.
      rerender({ guest: false });
      await waitFor(() => expect(result.current.loading).toBe(false));

      // Оба POST'а выполнены с правильными payload'ами.
      expect(mockedApi.post).toHaveBeenCalledTimes(2);
      expect(mockedApi.post).toHaveBeenCalledWith(
        '/user/saved-filters',
        expect.objectContaining({
          section: 'archive',
          name: 'A',
          params: expect.objectContaining({ eco: 'B90' }),
        }),
      );
      // LS очищен.
      expect(localStorage.getItem(GUEST_ARCHIVE_KEY)).toBeNull();
      // filters берутся с сервера (GET).
      expect(result.current.filters.map((f) => f.id)).toEqual([
        'srv-a',
        'srv-b',
      ]);
      expect(result.current.isGuestMode).toBe(false);
    });

    it('409 на одном пресете → запись удаляется из LS, остальное мигрирует', async () => {
      const a = makeGuestArchiveDto('local-a', 'Dup');
      const b = makeGuestArchiveDto('local-b', 'OK');
      localStorage.setItem(GUEST_ARCHIVE_KEY, JSON.stringify([a, b]));

      mockedApi.post
        .mockRejectedValueOnce(new ApiError('dup', undefined, 409))
        .mockResolvedValueOnce({ ...b, id: 'srv-b' });
      mockedApi.get.mockResolvedValueOnce([
        { ...b, id: 'srv-b' },
      ]);

      const { result, rerender } = renderHook(
        ({ guest }: { guest: boolean }) =>
          useSavedFilters('archive', { isGuest: guest }),
        { initialProps: { guest: true } },
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      rerender({ guest: false });
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(mockedApi.post).toHaveBeenCalledTimes(2);
      // 409 — запись «уже на сервере», локальная копия удалена.
      // Поскольку остальные тоже успешно — LS полностью очищен.
      expect(localStorage.getItem(GUEST_ARCHIVE_KEY)).toBeNull();
    });

    it('400 (лимит) → миграция останавливается, хвост остаётся в LS', async () => {
      const a = makeGuestArchiveDto('local-a', 'A');
      const b = makeGuestArchiveDto('local-b', 'B');
      const c = makeGuestArchiveDto('local-c', 'C');
      localStorage.setItem(
        GUEST_ARCHIVE_KEY,
        JSON.stringify([a, b, c]),
      );

      // a — успех; b — 400 (limit); c — не вызывается, добавляется в failed.
      mockedApi.post
        .mockResolvedValueOnce({ ...a, id: 'srv-a' })
        .mockRejectedValueOnce(new ApiError('limit', undefined, 400));
      mockedApi.get.mockResolvedValueOnce([{ ...a, id: 'srv-a' }]);

      const { result, rerender } = renderHook(
        ({ guest }: { guest: boolean }) =>
          useSavedFilters('archive', { isGuest: guest }),
        { initialProps: { guest: true } },
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      rerender({ guest: false });
      await waitFor(() => expect(result.current.loading).toBe(false));

      // Был сделан POST a (успех) и b (400). c — пропущен.
      expect(mockedApi.post).toHaveBeenCalledTimes(2);
      // В LS остались b и c (failed).
      const remaining = JSON.parse(
        localStorage.getItem(GUEST_ARCHIVE_KEY) ?? '[]',
      ) as SavedFilterDto[];
      expect(remaining.map((f) => f.id)).toEqual(['local-b', 'local-c']);
    });

    it('LS пуст при логине → миграция пропускается, обычный GET', async () => {
      mockedApi.get.mockResolvedValueOnce([]);
      const { result, rerender } = renderHook(
        ({ guest }: { guest: boolean }) =>
          useSavedFilters('archive', { isGuest: guest }),
        { initialProps: { guest: true } },
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      rerender({ guest: false });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockedApi.post).not.toHaveBeenCalled();
      expect(mockedApi.get).toHaveBeenCalled();
    });
  });
});
