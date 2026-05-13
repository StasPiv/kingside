/**
 * KS-2924 / KS-2931 Phase B1 — хук сохранённых фильтров.
 *
 * Источник контракта: `@kingside/shared` (Phase A4, KS-2928). REST —
 * `/api/user/saved-filters` (Phase A3, KS-2927).
 *
 * Контракт хука:
 *   - один экземпляр на пару (страница, section);
 *   - инициализирующий GET в `useEffect`;
 *   - все мутации — optimistic update с откатом на ошибке;
 *   - 409 → `SavedFiltersError('duplicate_name')`,
 *     400 → `SavedFiltersError('limit_reached')` (см. `mapMutationError`);
 *   - для `section='workshop'` — однократная миграция старого
 *     `localStorage['workshopSavedFilters']` в БД при первом монтировании,
 *     идемпотентно (если БД непустая или ключ отсутствует — пропустить
 *     и удалить ключ, чтобы не пытаться снова).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CreateSavedFilterPayload,
  SavedFilterDto,
  SavedFilterParams,
  SavedFilterSection,
  UpdateSavedFilterPayload,
} from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';

/** Ключ старого формата (use case до KS-2924): массив объектов
 *  `{ name, category, tags, search }` в `localStorage`. */
export const LS_LEGACY_WORKSHOP_KEY = 'workshopSavedFilters';

/** Префикс id для optimistic-записи до подтверждения сервером.
 *  Гарантирует, что UI может отличить optimistic-id от реального
 *  UUID (например, чтобы отключить «Update from current» до коммита). */
const OPTIMISTIC_ID_PREFIX = '__optimistic_';

export type SavedFiltersErrorCode = 'duplicate_name' | 'limit_reached';

/**
 * Типизированная ошибка мутации saved-filter. UI смотрит на `code`,
 * чтобы показать локализованное сообщение, а не парсит `message` /
 * `status`. Поле `cause` сохраняет исходную `ApiError` для логов.
 */
export class SavedFiltersError extends Error {
  public readonly code: SavedFiltersErrorCode;
  public override readonly cause?: unknown;
  constructor(code: SavedFiltersErrorCode, cause?: unknown) {
    super(code);
    this.name = 'SavedFiltersError';
    this.code = code;
    this.cause = cause;
  }
}

export interface UseSavedFiltersResult<T extends SavedFilterParams> {
  filters: SavedFilterDto[];
  loading: boolean;
  error: string | null;
  create: (name: string, params: T) => Promise<SavedFilterDto>;
  rename: (id: string, name: string) => Promise<void>;
  update: (id: string, params: T) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** Внутренний legacy-формат фильтра в localStorage (workshop, до A3). */
interface LegacyWorkshopFilter {
  name?: string;
  category?: string | null;
  /** В разных версиях встречалось string[] или comma-string. */
  tags?: string[] | string | null;
  search?: string | null;
  sortOrder?: string | null;
}

function isOptimisticId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_ID_PREFIX);
}

function makeOptimisticId(): string {
  return `${OPTIMISTIC_ID_PREFIX}${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Маппинг ошибок API → доменные коды. Не-ApiError и нераспознанные
 * статусы пробрасываются как есть (UI покажет generic toast).
 */
function toMutationError(e: unknown): unknown {
  if (e instanceof ApiError) {
    if (e.status === 409) return new SavedFiltersError('duplicate_name', e);
    if (e.status === 400) return new SavedFiltersError('limit_reached', e);
  }
  return e;
}

/**
 * Преобразование старой записи `workshopSavedFilters` в каноничные
 * `SavedFilterParams` секции `workshop`. Семантика старых полей:
 *   - `category === 'all' || ''` → `null` (фильтр сброшен);
 *   - `tags` как `string` (CSV) → разбиваем по запятой, trim;
 *   - `search === ''` → `null`;
 *   - `sortOrder` в старом формате не хранился → `null`.
 */
function legacyToWorkshopParams(item: LegacyWorkshopFilter): SavedFilterParams {
  const rawCategory = item.category;
  const category =
    !rawCategory || rawCategory === 'all' ? null : rawCategory;

  const rawTags = item.tags;
  const tags: string[] = Array.isArray(rawTags)
    ? rawTags.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : typeof rawTags === 'string'
      ? rawTags
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];

  const search = item.search && item.search.length > 0 ? item.search : null;
  const sortOrder =
    item.sortOrder && item.sortOrder.length > 0 ? item.sortOrder : null;

  return { section: 'workshop', category, tags, search, sortOrder };
}

/**
 * Безопасное чтение legacy-ключа из localStorage. Возвращает массив
 * legacy-записей либо пустой массив (на любые ошибки парсинга /
 * недоступности storage).
 */
function readLegacyWorkshopFilters(): LegacyWorkshopFilter[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(LS_LEGACY_WORKSHOP_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is LegacyWorkshopFilter =>
        typeof x === 'object' && x !== null && !Array.isArray(x),
    );
  } catch {
    return [];
  }
}

function clearLegacyWorkshopKey(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LS_LEGACY_WORKSHOP_KEY);
    }
  } catch {
    /* ignore — приватный режим / quota */
  }
}

export function useSavedFilters<
  T extends SavedFilterParams = SavedFilterParams,
>(section: SavedFilterSection): UseSavedFiltersResult<T> {
  const [filters, setFilters] = useState<SavedFilterDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Флаг идемпотентности миграции localStorage для секции workshop.
   * Хранится в ref, потому что:
   *   - React 18 StrictMode дважды вызывает effect на mount;
   *   - переключение section туда-обратно не должно повторять миграцию,
   *     если она уже выполнена в рамках одного экземпляра хука.
   */
  const workshopMigrationAttemptedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const path = `/user/saved-filters?section=${encodeURIComponent(section)}`;

    (async () => {
      try {
        const rawInitial = await api.get<SavedFilterDto[]>(path);
        if (cancelled) return;
        // KS-2937: защита от моков/мутаций, где api.get вернул не-массив
        // (например, stub `Response({})` в общем тестовом setup).
        // Без этого UI-ветка `.filter`/`.map` падала бы каскадом, и
        // существующие тесты других страниц с подключённым dropdown'ом
        // получали бы шум, не относящийся к их сценариям.
        const initial: SavedFilterDto[] = Array.isArray(rawInitial)
          ? rawInitial
          : [];

        let next: SavedFilterDto[] = initial;

        if (
          section === 'workshop' &&
          !workshopMigrationAttemptedRef.current
        ) {
          workshopMigrationAttemptedRef.current = true;

          if (initial.length > 0) {
            // БД уже содержит фильтры — миграция считается выполненной.
            // Удаляем legacy-ключ, чтобы не накапливать «сиротский» state.
            clearLegacyWorkshopKey();
          } else {
            const legacy = readLegacyWorkshopFilters();
            if (legacy.length > 0) {
              const migrated = await Promise.all(
                legacy.map((item) => {
                  const name = (item.name ?? '').trim() || 'Untitled';
                  const payload: CreateSavedFilterPayload = {
                    section: 'workshop',
                    name,
                    params: legacyToWorkshopParams(item),
                  };
                  return api
                    .post<SavedFilterDto>('/user/saved-filters', payload)
                    .catch(() => null);
                }),
              );
              if (cancelled) return;
              const created = migrated.filter(
                (x): x is SavedFilterDto => x !== null,
              );
              if (created.length > 0) {
                next = [...created, ...initial];
              }
            }
            // Best-effort: даже если что-то не загрузилось, очищаем
            // legacy-ключ, чтобы не дублировать попытки на каждом mount.
            clearLegacyWorkshopKey();
          }
        }

        if (!cancelled) {
          setFilters(next);
          setLoading(false);
        }
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof Error ? e.message : 'Failed to load saved filters',
        );
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [section]);

  const create = useCallback(
    async (name: string, params: T): Promise<SavedFilterDto> => {
      const tempId = makeOptimisticId();
      const nowIso = new Date().toISOString();
      const optimistic: SavedFilterDto = {
        id: tempId,
        section,
        name,
        params,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      setFilters((prev) => [optimistic, ...prev]);
      try {
        const payload: CreateSavedFilterPayload = { section, name, params };
        const created = await api.post<SavedFilterDto>(
          '/user/saved-filters',
          payload,
        );
        setFilters((prev) =>
          prev.map((f) => (f.id === tempId ? created : f)),
        );
        return created;
      } catch (e) {
        setFilters((prev) => prev.filter((f) => f.id !== tempId));
        throw toMutationError(e);
      }
    },
    [section],
  );

  const rename = useCallback(
    async (id: string, name: string): Promise<void> => {
      if (isOptimisticId(id)) {
        // optimistic-запись ещё не подтверждена сервером — переименование
        // по временному id запрещено (нет реального PATCH-эндпоинта).
        throw new Error('Cannot rename optimistic filter before commit');
      }
      let previousName: string | undefined;
      setFilters((prev) =>
        prev.map((f) => {
          if (f.id === id) {
            previousName = f.name;
            return { ...f, name };
          }
          return f;
        }),
      );
      try {
        const payload: UpdateSavedFilterPayload = { name };
        await api.patch<SavedFilterDto>(
          `/user/saved-filters/${id}`,
          payload,
        );
      } catch (e) {
        if (previousName !== undefined) {
          const restored = previousName;
          setFilters((prev) =>
            prev.map((f) => (f.id === id ? { ...f, name: restored } : f)),
          );
        }
        throw toMutationError(e);
      }
    },
    [],
  );

  const update = useCallback(
    async (id: string, params: T): Promise<void> => {
      if (isOptimisticId(id)) {
        throw new Error('Cannot update optimistic filter before commit');
      }
      let previousParams: SavedFilterParams | undefined;
      setFilters((prev) =>
        prev.map((f) => {
          if (f.id === id) {
            previousParams = f.params;
            return { ...f, params };
          }
          return f;
        }),
      );
      try {
        const payload: UpdateSavedFilterPayload = { params };
        await api.patch<SavedFilterDto>(
          `/user/saved-filters/${id}`,
          payload,
        );
      } catch (e) {
        if (previousParams !== undefined) {
          const restored = previousParams;
          setFilters((prev) =>
            prev.map((f) => (f.id === id ? { ...f, params: restored } : f)),
          );
        }
        throw toMutationError(e);
      }
    },
    [],
  );

  const remove = useCallback(async (id: string): Promise<void> => {
    if (isOptimisticId(id)) {
      // Удаление неподтверждённой optimistic-записи — просто чистим стейт,
      // запроса в API нет.
      setFilters((prev) => prev.filter((f) => f.id !== id));
      return;
    }
    let removed: SavedFilterDto | undefined;
    let removedIndex = -1;
    setFilters((prev) => {
      const idx = prev.findIndex((f) => f.id === id);
      if (idx < 0) return prev;
      removed = prev[idx];
      removedIndex = idx;
      const next = prev.slice();
      next.splice(idx, 1);
      return next;
    });
    try {
      await api.delete(`/user/saved-filters/${id}`);
    } catch (e) {
      if (removed && removedIndex >= 0) {
        const restored = removed;
        const restoreIndex = removedIndex;
        setFilters((prev) => {
          const next = prev.slice();
          // Если индекс выходит за пределы — кладём в начало (запас на
          // случай параллельных мутаций между optimistic-remove и откатом).
          const safeIndex = Math.min(restoreIndex, next.length);
          next.splice(safeIndex, 0, restored);
          return next;
        });
      }
      throw toMutationError(e);
    }
  }, []);

  return { filters, loading, error, create, rename, update, remove };
}
