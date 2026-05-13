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

/** KS-2944: префикс LS-ключа для гостевых пресетов. Полный ключ —
 *  `savedFilters:archive` / `savedFilters:workshop`. */
export const GUEST_LS_KEY_PREFIX = 'savedFilters:';

/** KS-2944: лимит на (user/guest, section) — совпадает с сервером. */
export const MAX_SAVED_FILTERS_PER_SECTION = 20;

/** Префикс id для optimistic-записи до подтверждения сервером.
 *  Гарантирует, что UI может отличить optimistic-id от реального
 *  UUID (например, чтобы отключить «Update from current» до коммита). */
const OPTIMISTIC_ID_PREFIX = '__optimistic_';

/** KS-2944: префикс id для гостевых пресетов (LS-режим). */
const GUEST_ID_PREFIX = 'local-';

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
  /**
   * KS-2944: `true` если хук работает в guest-режиме (LS вместо API).
   * UI может опционально показать подсказку «эти фильтры сохранены
   * только в этом браузере».
   */
  isGuestMode: boolean;
  create: (name: string, params: T) => Promise<SavedFilterDto>;
  rename: (id: string, name: string) => Promise<void>;
  update: (id: string, params: T) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/**
 * KS-2944: опции хука. По умолчанию `isGuest=false` (auth-режим),
 * чтобы существующие вызовы (Dropdown без явного prop'а в тестах)
 * не сломались. Страницы-родители вычисляют `isGuest` через
 * `useAuth()` и передают сюда.
 */
export interface UseSavedFiltersOptions {
  isGuest?: boolean;
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

/** KS-2944: ключ LS для гостевого хранилища пресетов конкретной секции. */
function guestStorageKey(section: SavedFilterSection): string {
  return `${GUEST_LS_KEY_PREFIX}${section}`;
}

/** KS-2944: безопасное чтение гостевых пресетов с фильтрацией мусора. */
function readGuestFilters(section: SavedFilterSection): SavedFilterDto[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(guestStorageKey(section));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is SavedFilterDto =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as { id?: unknown }).id === 'string' &&
        typeof (x as { name?: unknown }).name === 'string' &&
        typeof (x as { section?: unknown }).section === 'string' &&
        typeof (x as { params?: unknown }).params === 'object',
    );
  } catch {
    return [];
  }
}

/** KS-2944: запись гостевых пресетов в LS (best-effort). */
function writeGuestFilters(
  section: SavedFilterSection,
  filters: SavedFilterDto[],
): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(guestStorageKey(section), JSON.stringify(filters));
  } catch {
    /* QuotaExceededError / приватный режим */
  }
}

function clearGuestFilters(section: SavedFilterSection): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(guestStorageKey(section));
    }
  } catch {
    /* ignore */
  }
}

/** KS-2944: уникальный id для гостевого пресета. UUID если crypto доступен. */
function makeLocalId(): string {
  const c =
    typeof globalThis !== 'undefined'
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (c && typeof c.randomUUID === 'function') {
    return `${GUEST_ID_PREFIX}${c.randomUUID()}`;
  }
  return `${GUEST_ID_PREFIX}${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function useSavedFilters<
  T extends SavedFilterParams = SavedFilterParams,
>(
  section: SavedFilterSection,
  options?: UseSavedFiltersOptions,
): UseSavedFiltersResult<T> {
  const isGuest = options?.isGuest ?? false;
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

  /**
   * KS-2944: предыдущее значение isGuest — нужно, чтобы при переходе
   * guest → auth (после успешного логина) запустить миграцию LS → API.
   * Инициализируем в `false`, чтобы initial mount с isGuest=true не
   * считался переходом (ничего мигрировать ещё некуда: пользователь
   * ещё не залогинен).
   */
  const prevIsGuestRef = useRef(isGuest);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // ---- KS-2944: guest-режим ----------------------------------------
    if (isGuest) {
      const guest = readGuestFilters(section);
      if (!cancelled) {
        setFilters(guest);
        setLoading(false);
      }
      // prevIsGuestRef обновится во втором useEffect.
      return () => {
        cancelled = true;
      };
    }

    const path = `/user/saved-filters?section=${encodeURIComponent(section)}`;

    (async () => {
      try {
        // KS-2944: миграция гостевых пресетов перед первым GET'ом
        // в auth-режиме (был isGuest=true, стал false — пользователь
        // только что залогинился). Без блокировки UI: при 409 запись
        // пропускается (на сервере уже такая существует), при 400
        // (лимит) — миграция останавливается, оставшиеся записи
        // сохраняются в LS для ручной чистки пользователем.
        if (prevIsGuestRef.current === true) {
          const guest = readGuestFilters(section);
          if (guest.length > 0) {
            let limitHit = false;
            const failedToMigrate: SavedFilterDto[] = [];
            for (const f of guest) {
              if (cancelled) return;
              if (limitHit) {
                failedToMigrate.push(f);
                continue;
              }
              try {
                await api.post<SavedFilterDto>('/user/saved-filters', {
                  section: f.section,
                  name: f.name,
                  params: f.params,
                } satisfies CreateSavedFilterPayload);
              } catch (postErr) {
                if (postErr instanceof ApiError) {
                  if (postErr.status === 409) {
                    // duplicate — на сервере уже есть, локальную удаляем.
                    continue;
                  }
                  if (postErr.status === 400) {
                    // лимит — стоп, сохраняем хвост.
                    limitHit = true;
                    failedToMigrate.push(f);
                    continue;
                  }
                }
                // сетевая / 5xx — сохраняем в LS, пользователь
                // повторит при следующем mount'е.
                failedToMigrate.push(f);
              }
            }
            if (failedToMigrate.length > 0) {
              writeGuestFilters(section, failedToMigrate);
            } else {
              clearGuestFilters(section);
            }
          }
        }

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
  }, [section, isGuest]);

  // KS-2944: фиксируем предыдущее значение isGuest после каждого
  // изменения. Update идёт В отдельном эффекте, чтобы выше иметь
  // доступ к `prevIsGuestRef.current` — старому значению.
  useEffect(() => {
    prevIsGuestRef.current = isGuest;
  }, [isGuest]);

  const create = useCallback(
    async (name: string, params: T): Promise<SavedFilterDto> => {
      const trimmedName = name.trim();
      // ---- KS-2944: guest-режим ------------------------------------
      if (isGuest) {
        const guest = readGuestFilters(section);
        if (guest.length >= MAX_SAVED_FILTERS_PER_SECTION) {
          throw new SavedFiltersError('limit_reached');
        }
        if (guest.some((f) => f.name === trimmedName)) {
          throw new SavedFiltersError('duplicate_name');
        }
        const nowIsoG = new Date().toISOString();
        const dto: SavedFilterDto = {
          id: makeLocalId(),
          section,
          name: trimmedName,
          params,
          createdAt: nowIsoG,
          updatedAt: nowIsoG,
        };
        const next = [dto, ...guest];
        writeGuestFilters(section, next);
        setFilters(next);
        return dto;
      }

      // ---- auth-режим (оригинальный optimistic-flow) ---------------
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
    [section, isGuest],
  );

  const rename = useCallback(
    async (id: string, name: string): Promise<void> => {
      const trimmedName = name.trim();
      // ---- KS-2944: guest-режим ------------------------------------
      if (isGuest) {
        const guest = readGuestFilters(section);
        const target = guest.find((f) => f.id === id);
        if (!target) {
          throw new Error('Saved filter not found');
        }
        if (
          guest.some((f) => f.id !== id && f.name === trimmedName)
        ) {
          throw new SavedFiltersError('duplicate_name');
        }
        const next = guest.map((f) =>
          f.id === id
            ? { ...f, name: trimmedName, updatedAt: new Date().toISOString() }
            : f,
        );
        writeGuestFilters(section, next);
        setFilters(next);
        return;
      }

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
    [section, isGuest],
  );

  const update = useCallback(
    async (id: string, params: T): Promise<void> => {
      // ---- KS-2944: guest-режим ------------------------------------
      if (isGuest) {
        const guest = readGuestFilters(section);
        const target = guest.find((f) => f.id === id);
        if (!target) {
          throw new Error('Saved filter not found');
        }
        const next = guest.map((f) =>
          f.id === id
            ? { ...f, params, updatedAt: new Date().toISOString() }
            : f,
        );
        writeGuestFilters(section, next);
        setFilters(next);
        return;
      }

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
    [section, isGuest],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      // ---- KS-2944: guest-режим ------------------------------------
      if (isGuest) {
        const guest = readGuestFilters(section);
        const next = guest.filter((f) => f.id !== id);
        // Если ничего не удалили — не пишем.
        if (next.length !== guest.length) {
          writeGuestFilters(section, next);
          setFilters(next);
        }
        return;
      }

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
    },
    [section, isGuest],
  );

  return {
    filters,
    loading,
    error,
    isGuestMode: isGuest,
    create,
    rename,
    update,
    remove,
  };
}
