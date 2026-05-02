import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import type {
  ArchiveGameResult,
  ArchiveGameSummary,
  ArchiveGamesRequest,
  ArchiveGamesSortMetadata,
  ArchiveTimeControlCategory,
} from '@kingside/shared';

import { archiveApi } from '../api/archive';
import { archivePreferencesApi } from '../api/archivePreferencesApi';
import { ArchiveGameRow } from '../components/archive/ArchiveGameRow';
import type { ArchiveFilters } from '@kingside/shared';
import {
  ArchiveMetadataFilters,
  EMPTY_METADATA_FILTERS,
  type ArchiveMetadataFilterValues,
  type MetadataResultFilter,
} from '../components/archive/ArchiveMetadataFilters';
import { ArchiveGamesByPositionPage } from './ArchiveGamesByPositionPage';

/**
 * KS-2068 (F2 / ADR-033 §4): универсальный список архива партий.
 *
 * Два режима по наличию `?fen=` в URL:
 *  1. **By-position** (есть `?fen=...`) — keyset-пагинация через
 *     `/api/archive/games/by-position`. Реализована в существующем
 *     `<ArchiveGamesByPositionPage>` (читает URL внутри себя). Здесь
 *     она просто рендерится — единая страница `/archive/games`
 *     поддерживает оба режима и не требует дублирования логики.
 *  2. **Metadata** (нет `?fen=`) — offset-пагинация через
 *     `/api/archive/games`. Фильтры из B1 (`player`, `event`, `eco`,
 *     `since`, `until`, `result`, `minElo`, `minPly`, `maxPly`,
 *     `sort`). Прев/некст + page-size selector (20/50/100).
 *
 * URL — единственный источник истины для фильтров и пагинации
 * (deep-link воспроизводит состояние).
 */

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

const VALID_SORTS: readonly ArchiveGamesSortMetadata[] = [
  'recent',
  'topElo',
  'oldest',
];
const VALID_RESULTS: readonly MetadataResultFilter[] = [
  'any',
  '1-0',
  '0-1',
  '1/2-1/2',
];
// KS-2115: набор валидных категорий контроля времени для URL-парсера.
// `unknown` тоже валиден на бэке (KS-2118), но в UI-форме скрыт —
// пользователь не выбирает его, deep-link с ним всё равно пройдёт корректно.
const VALID_TIME_CONTROL_CATEGORIES: readonly ArchiveTimeControlCategory[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'unknown',
];

function parseTimeControlCategories(
  raw: string[],
): ArchiveTimeControlCategory[] {
  const seen = new Set<ArchiveTimeControlCategory>();
  for (const r of raw) {
    if (
      VALID_TIME_CONTROL_CATEGORIES.includes(r as ArchiveTimeControlCategory)
    ) {
      seen.add(r as ArchiveTimeControlCategory);
    }
  }
  return Array.from(seen);
}

function parseSort(raw: string | null): ArchiveGamesSortMetadata {
  return VALID_SORTS.includes(raw as ArchiveGamesSortMetadata)
    ? (raw as ArchiveGamesSortMetadata)
    : 'recent';
}

function parseResult(raw: string | null): MetadataResultFilter {
  return VALID_RESULTS.includes(raw as MetadataResultFilter)
    ? (raw as MetadataResultFilter)
    : 'any';
}

function parseNonNegativeInt(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function parsePageSize(raw: string | null): number {
  const n = Number(raw);
  return PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number])
    ? n
    : DEFAULT_PAGE_SIZE;
}

/**
 * Превращает URL search params в `ArchiveMetadataFilterValues`. Любые
 * невалидные значения откатываются к дефолту (см. `EMPTY_METADATA_FILTERS`).
 */
export function urlToMetadataFilters(
  params: URLSearchParams,
): ArchiveMetadataFilterValues {
  // KS-2084: `player` приходит как 0..N значений (`?player=A&player=B`).
  // `getAll` сохраняет все, `get` — только первое. Старые ссылки с
  // одним `player=` тоже корректно превратятся в `[name]`.
  const players = params
    .getAll('player')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return {
    players,
    event: params.get('event') ?? '',
    eco: params.get('eco') ?? '',
    result: parseResult(params.get('result')),
    minElo: parseNonNegativeInt(params.get('minElo')),
    since: params.get('since') ?? '',
    until: params.get('until') ?? '',
    minPly: parseNonNegativeInt(params.get('minPly')),
    maxPly: parseNonNegativeInt(params.get('maxPly')),
    sort: parseSort(params.get('sort')),
    // KS-2115: множественный фильтр контроля времени. Каждое значение —
    // отдельный `?timeControlCategory=...` (Express парсит дубликаты как
    // массив). Невалидные значения тихо отбрасываем.
    timeControlCategory: parseTimeControlCategories(
      params.getAll('timeControlCategory'),
    ),
  };
}

/**
 * Сериализует фильтры в URLSearchParams. Пустые значения / `null` /
 * дефолтный sort=`recent` опускаются — URL остаётся чистым.
 */
export function metadataFiltersToUrl(
  values: ArchiveMetadataFilterValues,
  page: number,
  pageSize: number,
  cursor?: string,
): URLSearchParams {
  const params = new URLSearchParams();
  // KS-2084: каждый игрок — отдельный `player=...` через `append`.
  // `set` затёр бы массив до одного значения.
  for (const p of values.players) {
    const trimmed = p.trim();
    if (trimmed.length > 0) params.append('player', trimmed);
  }
  if (values.event) params.set('event', values.event);
  if (values.eco) params.set('eco', values.eco);
  if (values.result !== 'any') params.set('result', values.result);
  if (values.minElo !== null) params.set('minElo', String(values.minElo));
  if (values.since) params.set('since', values.since);
  if (values.until) params.set('until', values.until);
  if (values.minPly !== null) params.set('minPly', String(values.minPly));
  if (values.maxPly !== null) params.set('maxPly', String(values.maxPly));
  if (values.sort !== 'recent') params.set('sort', values.sort);
  // KS-2115: каждый элемент — отдельный `timeControlCategory=...` через
  // append (`set` затёр бы массив до одного значения).
  for (const cat of values.timeControlCategory) {
    params.append('timeControlCategory', cat);
  }
  if (page > 1) params.set('page', String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE)
    params.set('pageSize', String(pageSize));
  // KS-2143: opaque keyset cursor сохраняется в URL, чтобы reload
  // конкретной страницы возвращал ту же позицию без COUNT/offset. На
  // первой странице (`page === 1`) cursor не нужен — backend отдаёт
  // первую страницу нужного sort'а.
  if (cursor && page > 1) params.set('cursor', cursor);
  return params;
}

/**
 * Превращает `ArchiveMetadataFilterValues` + page/pageSize в
 * `ArchiveGamesRequest` для `archiveApi.getArchiveGamesMetadata`.
 */
export function metadataFiltersToRequest(
  values: ArchiveMetadataFilterValues,
  page: number,
  pageSize: number,
  cursor?: string,
): ArchiveGamesRequest {
  return {
    // KS-2084: 0 → undefined, 1 → string (бэк-совместимо), 2+ → string[].
    // Контракт `ArchiveGamesRequest.player: string | string[] | undefined`.
    player:
      values.players.length === 0
        ? undefined
        : values.players.length === 1
          ? values.players[0]
          : values.players,
    event: values.event || undefined,
    eco: values.eco || undefined,
    result:
      values.result === 'any' ? undefined : (values.result as ArchiveGameResult),
    minElo: values.minElo ?? undefined,
    since: values.since || undefined,
    until: values.until || undefined,
    minPly: values.minPly ?? undefined,
    maxPly: values.maxPly ?? undefined,
    sort: values.sort,
    // KS-2115: 0 → undefined, 1 → string (бэк-совместимо), 2+ → string[].
    // Контракт `ArchiveGamesRequest.timeControlCategory: T | T[] | undefined`.
    timeControlCategory:
      values.timeControlCategory.length === 0
        ? undefined
        : values.timeControlCategory.length === 1
          ? values.timeControlCategory[0]
          : values.timeControlCategory,
    limit: pageSize,
    // KS-2143: keyset cursor имеет приоритет на бэке (offset
    // игнорируется). Передаём cursor когда он есть в URL — типичный
    // путь после Next-клика. Если cursor пуст (deep-link reload
    // `?page=N`) — fallback на offset, бэкенд это поддерживает.
    cursor: cursor || undefined,
    offset: cursor ? undefined : (page - 1) * pageSize,
  };
}

export function ArchiveGamesPage() {
  const [searchParams] = useSearchParams();
  // KS-2068: dispatch по `?fen=`. By-position режим полностью
  // делегируется существующему компоненту (он сам читает URL).
  if (searchParams.get('fen')) {
    return <ArchiveGamesByPositionPage />;
  }
  return <ArchiveMetadataMode />;
}

const SKELETON_ROWS = 10;

// KS-2210: ключ localStorage для фоллбека (гости / протухший токен).
const FILTERS_LS_KEY = 'archive_metadata_filters_v1';

/** Сохраняет фильтры в localStorage (фоллбек для неавторизованных). */
function saveFiltersToStorage(filters: ArchiveMetadataFilterValues): void {
  try {
    localStorage.setItem(FILTERS_LS_KEY, JSON.stringify(filters));
  } catch {
    /* QuotaExceededError / Private Mode */
  }
}

/** Читает фильтры из localStorage. */
function readFiltersFromStorage(): Partial<ArchiveMetadataFilterValues> | null {
  try {
    const raw = localStorage.getItem(FILTERS_LS_KEY);
    if (raw) return JSON.parse(raw) as Partial<ArchiveMetadataFilterValues>;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * KS-2210: маппинг frontend-фильтров → тело PUT /user/preferences/archive-filters.
 *
 * Дефолтные значения (result='any', sort='recent', пустые массивы) сохраняем
 * как null — чтобы не засорять JSONB и упростить проверку «пустых» фильтров.
 *
 * players[] → player: первый элемент (ограничение API: одно поле).
 * timeControlCategory[] → timeControl: join(',') для компактного хранения.
 */
function filtersToApiPayload(values: ArchiveMetadataFilterValues): ArchiveFilters {
  return {
    player: values.players.length > 0 ? values.players[0] : null,
    event: values.event || null,
    eco: values.eco || null,
    result: values.result !== 'any' ? values.result : null,
    timeControl:
      values.timeControlCategory.length > 0
        ? values.timeControlCategory.join(',')
        : null,
    minElo: values.minElo ?? null,
    since: values.since || null,
    until: values.until || null,
    minPly: values.minPly ?? null,
    maxPly: values.maxPly ?? null,
    sort: values.sort !== 'recent' ? values.sort : null,
  };
}

/**
 * KS-2210: маппинг ответа GET /user/preferences/archive-filters → фронтовые значения.
 */
function apiFiltersToValues(
  saved: ArchiveFilters,
): Partial<ArchiveMetadataFilterValues> {
  const result: Partial<ArchiveMetadataFilterValues> = {};
  if (saved.player) result.players = [saved.player];
  if (saved.event) result.event = saved.event;
  if (saved.eco) result.eco = saved.eco;
  if (saved.result && saved.result !== 'any') {
    result.result = saved.result as MetadataResultFilter;
  }
  if (saved.timeControl) {
    const cats = saved.timeControl
      .split(',')
      .filter((c): c is (typeof VALID_TIME_CONTROL_CATEGORIES)[number] =>
        VALID_TIME_CONTROL_CATEGORIES.includes(
          c as (typeof VALID_TIME_CONTROL_CATEGORIES)[number],
        ),
      );
    if (cats.length > 0) result.timeControlCategory = cats;
  }
  if (saved.minElo != null) result.minElo = saved.minElo;
  if (saved.since) result.since = saved.since;
  if (saved.until) result.until = saved.until;
  if (saved.minPly != null) result.minPly = saved.minPly;
  if (saved.maxPly != null) result.maxPly = saved.maxPly;
  if (saved.sort) result.sort = saved.sort as ArchiveGamesSortMetadata;
  return result;
}

function ArchiveMetadataMode() {
  const { t } = useTranslation('archive');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // KS-2210: авторизация через контекст, а не через localStorage напрямую.
  // AuthContext может вытереть токен из localStorage после 401 на /auth/me,
  // поэтому проверяем user из контекста — он точно отражает текущее состояние.
  const { user, loading: authLoading } = useAuth();
  // Ref для scheduleSaveFilters — не добавляем user в deps всех useCallback.
  const isAuthedRef = useRef(user !== null);

  const filterValues = useMemo(
    () => urlToMetadataFilters(searchParams),
    [searchParams],
  );
  const pageSize = parsePageSize(searchParams.get('pageSize'));
  // KS-2144: deep-link `?cursor=...` или `?page=N` поддерживаем как
  // «начальная позиция»: с этой страницы дозагружаем дальше через
  // scroll. Дальше URL не обновляется — состояние живёт в SPA-памяти.
  const initialPage = Math.max(
    1,
    parseNonNegativeInt(searchParams.get('page')) ?? 1,
  );
  const initialCursor = searchParams.get('cursor') ?? undefined;

  // KS-2144: ключ запроса для reset-эффекта. Меняется при смене
  // фильтров / sort / pageSize / deep-link cursor'а — это и есть
  // сигнал «список нужно очистить и начать сначала». Сериализуем
  // через JSON, чтобы primitives & вложенные массивы сравнивались по
  // содержимому (не по ссылке).
  const reqKey = useMemo(
    () => JSON.stringify({ filterValues, pageSize, initialPage, initialCursor }),
    [filterValues, pageSize, initialPage, initialCursor],
  );

  const [items, setItems] = useState<ArchiveGameSummary[]>([]);
  // `nextCursor` из последнего ответа: `null` — достигли конца архива
  // (`undefined` — данных пока нет; стартовый запрос ещё не вернулся).
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(
    undefined,
  );
  // Метаданные первой страницы — нужно знать total для clean recent
  // (cache-path). На дозагрузках total из ответа игнорируем, оно всё
  // равно `null` для всех не-cache путей.
  const [firstPageTotal, setFirstPageTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // KS-2144: sentinel для IntersectionObserver и стабильная ссылка на
  // loader, чтобы пересоздание observer'а на каждый рендер не
  // приводил к лишним вызовам.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<() => void>(() => {});

  // KS-2149: race-condition guard'ы.
  //  - `requestSeqRef` — монотонный счётчик. Каждый запрос (initial /
  //    loadMore) инкрементирует и захватывает локальный `mySeq`.
  //    Перед setState проверяет `mySeq === requestSeqRef.current` —
  //    игнорирует устаревшие ответы, пришедшие после смены фильтра.
  //  - `inflightAbortRef` — AbortController последнего in-flight
  //    запроса. При reset / повторном loadMore — abort предыдущего.
  const requestSeqRef = useRef(0);
  const inflightAbortRef = useRef<AbortController | null>(null);

  const writeFilters = useCallback(
    (next: ArchiveMetadataFilterValues, nextPageSize: number) => {
      // KS-2144: после любого изменения формы URL чистый — без cursor
      // и без page (page=1, pageSize пишется только если ≠ дефолта).
      const params = metadataFiltersToUrl(next, 1, nextPageSize);
      setSearchParams(params, { replace: true });
    },
    [setSearchParams],
  );

  // KS-2210: синхронизируем ref при смене auth-состояния (user из контекста).
  // Ref нужен чтобы scheduleSaveFilters не получал user в зависимости и не
  // пересоздавал handleFiltersChange при каждом обновлении профиля.
  useEffect(() => {
    isAuthedRef.current = user !== null;
  }, [user]);

  // KS-2210: таймер дебаунса для PUT /user/preferences/archive-filters.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Сброс таймера при размонтировании.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // KS-2210: сохранение фильтров — гибрид: сервер для авторизованных,
  // localStorage как фоллбек для гостей / просроченного токена.
  // Для сервера — дебаунс 1 сек (чтобы не PUT на каждую клавишу).
  // Для localStorage — немедленно (нет смысла откладывать).
  const scheduleSaveFilters = useCallback(
    (values: ArchiveMetadataFilterValues) => {
      if (isAuthedRef.current) {
        // Авторизован → PUT на сервер (дебаунс 1 с)
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          archivePreferencesApi
            .putFilters(filtersToApiPayload(values))
            .catch(() => {
              /* игнорируем сетевые ошибки — восстановление некритично */
            });
        }, 1000);
      } else {
        // Не авторизован / протухший токен → localStorage фоллбек
        saveFiltersToStorage(values);
      }
    },
    [],
  );

  // KS-2210: восстановление фильтров после разрешения auth.
  // Ждём authLoading=false — user отражает актуальное состояние.
  // Если авторизован → GET с сервера; иначе → localStorage фоллбек.
  // URL — источник истины: если уже есть не-дефолтные фильтры — не трогаем.
  const hasTriedRestoreRef = useRef(false);
  useEffect(() => {
    if (authLoading) return;
    if (hasTriedRestoreRef.current) return; // только один раз после auth resolve
    hasTriedRestoreRef.current = true;

    const currentParams = new URLSearchParams(window.location.search);
    const currentFilters = urlToMetadataFilters(currentParams);
    const hasNonDefaultFilters =
      currentFilters.players.length > 0 ||
      !!currentFilters.event ||
      !!currentFilters.eco ||
      currentFilters.result !== 'any' ||
      currentFilters.minElo !== null ||
      !!currentFilters.since ||
      !!currentFilters.until ||
      currentFilters.minPly !== null ||
      currentFilters.maxPly !== null ||
      currentFilters.sort !== 'recent' ||
      currentFilters.timeControlCategory.length > 0;
    if (hasNonDefaultFilters) return;

    /** Применяет частичные фильтры в URL */
    const applyPartial = (partial: Partial<ArchiveMetadataFilterValues>) => {
      const restored: ArchiveMetadataFilterValues = {
        ...EMPTY_METADATA_FILTERS,
        ...partial,
      };
      const params = metadataFiltersToUrl(restored, 1, DEFAULT_PAGE_SIZE);
      if (params.toString().length > 0) {
        setSearchParams(params, { replace: true });
      }
    };

    if (user) {
      // Авторизован → GET с сервера
      let cancelled = false;
      archivePreferencesApi
        .getFilters()
        .then((res) => {
          if (cancelled) return;
          if (Object.keys(res.filters).length === 0) return;
          applyPartial(apiFiltersToValues(res.filters));
        })
        .catch(() => {
          /* сессия не активна или сеть недоступна — молча пропускаем */
        });
      return () => {
        cancelled = true;
      };
    } else {
      // Не авторизован / протухший токен → localStorage фоллбек
      const stored = readFiltersFromStorage();
      if (stored) applyPartial(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  const handleFiltersChange = useCallback(
    (next: ArchiveMetadataFilterValues) => {
      writeFilters(next, pageSize);
      scheduleSaveFilters(next);
    },
    [pageSize, writeFilters, scheduleSaveFilters],
  );

  const handlePageSizeChange = useCallback(
    (size: number) => {
      writeFilters(filterValues, size);
    },
    [filterValues, writeFilters],
  );

  const handleResetFilters = useCallback(() => {
    writeFilters(EMPTY_METADATA_FILTERS, pageSize);
    scheduleSaveFilters(EMPTY_METADATA_FILTERS);
  }, [pageSize, writeFilters, scheduleSaveFilters]);

  // KS-2208: прямой переход в анализ без промежуточного экрана.
  // Загружаем PGN через API и сразу навигируем в /analysis.
  // При ошибке — fallback на ArchiveGamePage (старое поведение).
  // KS-2210: для неавторизованных сохраняем фильтры в localStorage перед
  // уходом — form-дебаунс может не успеть сработать.
  const handleRowClick = useCallback(
    (item: { id: string }) => {
      if (!isAuthedRef.current) saveFiltersToStorage(filterValues);
      archiveApi
        .getArchiveGameById(item.id)
        .then((game) => {
          const whiteLabel = game.white.name ?? '—';
          const blackLabel = game.black.name ?? '—';
          const currentSearch = searchParams.toString();
          const backUrl = currentSearch
            ? `/archive/games?${currentSearch}`
            : '/archive/games';
          navigate('/analysis', {
            state: {
              pgn: game.pgn,
              title: `${whiteLabel} vs ${blackLabel}`,
              breadcrumbRootTitle: t('games.title', 'Archive games'),
              breadcrumbRootUrl: '/archive/games',
              breadcrumbSection: game.event ?? undefined,
              breadcrumbBackUrl: backUrl,
            },
          });
        })
        .catch(() => {
          navigate(`/archive/games/${item.id}`);
        });
    },
    [navigate, searchParams, t, filterValues],
  );

  // ─── Initial / reset загрузка ────────────────────────────────────
  // KS-2144: reqKey меняется при любом изменении формы или deep-link
  // — обнуляем items, скроллим вверх, запрашиваем первую страницу
  // (с учётом deep-link initial cursor / page).
  // KS-2149: AbortController + seq-guard. При rapid filter change
  // (debounce 400ms на player input, KS-2125) inflight loadMore от
  // старого фильтра мог раньше прийти быстрее новой initial и
  // зааппендиться в свежий список — отсюда дубли. Теперь:
  //   1. Перед новым запросом — abort предыдущего.
  //   2. Ответ применяется только если `mySeq === requestSeqRef.current`
  //      — иначе тихо игнорируем (пришёл от старого фильтра).
  useEffect(() => {
    const mySeq = ++requestSeqRef.current;
    inflightAbortRef.current?.abort();
    const controller = new AbortController();
    inflightAbortRef.current = controller;

    setItems([]);
    setNextCursor(undefined);
    setFirstPageTotal(null);
    setLoading(true);
    setError(null);
    // Скролл к верху — чтобы при смене фильтра пользователь не
    // оставался на середине предыдущего списка.
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    archiveApi
      .getArchiveGamesMetadata(
        metadataFiltersToRequest(
          filterValues,
          initialPage,
          pageSize,
          initialCursor,
        ),
        controller.signal,
      )
      .then((res) => {
        if (mySeq !== requestSeqRef.current) return;
        setItems(res.items);
        setNextCursor(res.nextCursor ?? null);
        setFirstPageTotal(res.total);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (mySeq !== requestSeqRef.current) return;
        if (e.name === 'AbortError') return;
        setError(e.message);
        setLoading(false);
      });
    return () => {
      // Cleanup на unmount / следующем рендере с новым reqKey:
      // отменяем in-flight, помечаем seq устаревшим (через инкремент
      // в новом запуске).
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey]);

  // KS-2144: дозагрузка следующей страницы по cursor. Никаких
  // повторных запросов пока loading/loadingMore = true. Если бэк
  // отдал `nextCursor: null` — больше не дёргаемся.
  // KS-2149: тот же seq-guard + abort — чтобы inflight loadMore от
  // старого фильтра не аппендился в новый список.
  const loadMore = useCallback(() => {
    if (loading || loadingMore) return;
    if (!nextCursor) return; // null или undefined
    const mySeq = ++requestSeqRef.current;
    inflightAbortRef.current?.abort();
    const controller = new AbortController();
    inflightAbortRef.current = controller;
    setLoadingMore(true);
    setError(null);
    archiveApi
      .getArchiveGamesMetadata(
        metadataFiltersToRequest(filterValues, 1, pageSize, nextCursor),
        controller.signal,
      )
      .then((res) => {
        if (mySeq !== requestSeqRef.current) return;
        setItems((prev) => {
          // KS-2149: дедупликация по id — safety net на случай если
          // бэк/observer прислал ту же страницу дважды.
          const seen = new Set(prev.map((p) => p.id));
          const fresh = res.items.filter((it) => !seen.has(it.id));
          return [...prev, ...fresh];
        });
        setNextCursor(res.nextCursor ?? null);
        setLoadingMore(false);
      })
      .catch((e: Error) => {
        if (mySeq !== requestSeqRef.current) return;
        if (e.name === 'AbortError') return;
        setError(e.message);
        setLoadingMore(false);
      });
  }, [loading, loadingMore, nextCursor, filterValues, pageSize]);

  // Стабилизируем ссылку на loadMore — observer создаётся реже.
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  // ─── IntersectionObserver: триггер дозагрузки ────────────────────
  useEffect(() => {
    // Дозагрузка не нужна — observer не вешаем.
    if (!nextCursor) return undefined;
    const sentinel = sentinelRef.current;
    if (!sentinel) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMoreRef.current();
          }
        }
      },
      // rootMargin: дозагружаем за 200px ДО появления sentinel в
      // viewport — пользователь не успевает заметить пустоту.
      { root: null, rootMargin: '200px', threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [nextCursor, items.length]);

  // KS-2141: `total` показывается только если бэк его реально посчитал
  // (clean recent / cache-path KS-2090). При фильтре `total === null`.
  // KS-2144: первая страница могла прийти с total для cache-path —
  // используем её, дальше total из дозагрузок игнорируем.
  const total: number | null = firstPageTotal;

  // ─── Сводка фильтров (для header'а) ──────────────────────────────
  const summaryParts: string[] = [];
  // KS-2084: для нескольких игроков показываем «player=A vs B» (S1
  // «Карлсен против Каруаны» — visible в заголовке сразу).
  if (filterValues.players.length > 0) {
    summaryParts.push(`player=${filterValues.players.join(' vs ')}`);
  }
  if (filterValues.event) summaryParts.push(`event=${filterValues.event}`);
  if (filterValues.eco) summaryParts.push(`ECO=${filterValues.eco}`);
  if (filterValues.result !== 'any')
    summaryParts.push(`result=${filterValues.result}`);
  if (filterValues.minElo !== null)
    summaryParts.push(`Elo≥${filterValues.minElo}`);
  if (filterValues.since) summaryParts.push(`since ${filterValues.since}`);
  if (filterValues.until) summaryParts.push(`until ${filterValues.until}`);
  if (filterValues.minPly !== null)
    summaryParts.push(`plies≥${filterValues.minPly}`);
  if (filterValues.maxPly !== null)
    summaryParts.push(`plies≤${filterValues.maxPly}`);
  if (filterValues.timeControlCategory.length > 0)
    summaryParts.push(`tc=${filterValues.timeControlCategory.join(',')}`);
  const hasActiveFilters = summaryParts.length > 0;
  const summaryText = hasActiveFilters
    ? summaryParts.join(' · ')
    : t('games.metadata.summaryAll', 'All archive games');

  return (
    <div
      className="archive-page archive-games-metadata"
      data-testid="archive-games-page"
      data-mode="metadata"
    >
      <header className="archive-games-metadata__header">
        <h1 className="archive-games-metadata__title">
          {t('games.title', 'Archive games')}
        </h1>
        <p
          className="archive-games-metadata__summary"
          data-testid="archive-games-metadata-summary"
        >
          {summaryText}
        </p>
        {/* KS-2141: «Total: N» показываем только когда бэкенд реально
            посчитал COUNT(*) (clean recent / cache-path KS-2090). При
            любом фильтре `total === null` — просто не выводим строку,
            чтобы не врать пользователю «0 партий» и не показывать
            прочерк. Пагинация при этом продолжает работать через
            `hasNext`. */}
        {total !== null && (
          <p
            className="archive-games-metadata__total"
            data-testid="archive-games-metadata-total"
          >
            {t('games.metadata.totalCount', {
              defaultValue: 'Total: {{count}}',
              count: total,
            })}
          </p>
        )}
      </header>

      <ArchiveMetadataFilters
        values={filterValues}
        onChange={handleFiltersChange}
        onReset={handleResetFilters}
      />

      {/* Список.
          KS-2135: скелет показываем при ЛЮБОМ запросе (initial / смена
          фильтра / сортировка / пагинация), а не только на первой
          загрузке. Иначе при холодном `/games` (5-7 сек, см. KS-2134)
          пользователь видит старые данные с зависшими кнопками и не
          понимает, что идёт загрузка. */}
      {loading && (
        <div
          className="archive-games-list archive-games-list--loading"
          data-testid="archive-games-skeleton"
        >
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className="archive-games-list__skeleton-row" />
          ))}
        </div>
      )}

      {!loading && error && items.length === 0 && (
        <div
          className="archive-games-list archive-games-list--error"
          data-testid="archive-games-error"
        >
          <span>
            {t('games.metadata.error', 'Failed to load games')}
          </span>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div
          className="archive-games-list archive-games-list--empty"
          data-testid="archive-games-empty"
        >
          <p>{t('games.metadata.empty', 'No games match these filters.')}</p>
          {hasActiveFilters && (
            <button
              type="button"
              className="archive-games-list__reset-filters"
              onClick={handleResetFilters}
              data-testid="archive-games-reset-filters"
            >
              {t('games.metadata.resetFilters', 'Reset filters')}
            </button>
          )}
        </div>
      )}

      {!loading && items.length > 0 && (
        <div
          className="archive-games-list"
          data-testid="archive-games-list"
        >
          <div className="archive-games-list__rows">
            {items.map((item) => (
              <ArchiveGameRow
                key={item.id}
                item={item}
                onClick={handleRowClick}
              />
            ))}
          </div>

          {/* KS-2144: дозагрузка по scroll. Skeleton-rows во время
              сетевого запроса — переиспользуем тот же класс что в
              initial skeleton, чтобы визуально продолжить список без
              прыжка. Sentinel — невидимый div для IntersectionObserver
              со 200px rootMargin: дозагрузка начинается до того, как
              пользователь увидит пустоту. */}
          {loadingMore && (
            <div
              className="archive-games-list archive-games-list--loading-more"
              data-testid="archive-games-loading-more"
            >
              {Array.from({ length: 3 }, (_, i) => (
                <div
                  key={i}
                  className="archive-games-list__skeleton-row"
                />
              ))}
            </div>
          )}

          {nextCursor && !loadingMore && (
            <div
              ref={sentinelRef}
              className="archive-games-list__sentinel"
              data-testid="archive-games-sentinel"
              aria-hidden="true"
            />
          )}

          {nextCursor === null && (
            <p
              className="archive-games-metadata__end"
              data-testid="archive-games-end"
            >
              {t('games.metadata.end', 'End of archive')}
            </p>
          )}

          {error && items.length > 0 && (
            <div
              className="archive-games-list__inline-error"
              data-testid="archive-games-inline-error"
            >
              <span>
                {t('games.metadata.error', 'Failed to load games')}
              </span>
              <button
                type="button"
                onClick={() => loadMore()}
                className="archive-games-list__retry"
              >
                {t('common.retry', 'Retry')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* KS-2144: page-size селектор остался — теперь это единственный
          элемент управления «гранулярностью». Total-строка (если есть)
          и сам селектор живут отдельно от списка. */}
      {(items.length > 0 || (total !== null && total > 0)) && (
        <div
          className="archive-games-metadata__footer"
          data-testid="archive-games-metadata-footer"
        >
          <label className="archive-games-metadata__page-size">
            <span>{t('games.metadata.pageSizeLabel', 'Per page')}</span>
            <select
              data-testid="archive-games-metadata-page-size"
              value={pageSize}
              onChange={(e) => handlePageSizeChange(Number(e.target.value))}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
