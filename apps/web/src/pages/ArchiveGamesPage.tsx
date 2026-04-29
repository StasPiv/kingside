import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  ArchiveGameResult,
  ArchiveGameSummary,
  ArchiveGamesRequest,
  ArchiveGamesResponse,
  ArchiveGamesSortMetadata,
  ArchiveTimeControlCategory,
} from '@kingside/shared';

import { archiveApi } from '../api/archive';
import { ArchiveGameRow } from '../components/archive/ArchiveGameRow';
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

function ArchiveMetadataMode() {
  const { t } = useTranslation('archive');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const filterValues = useMemo(
    () => urlToMetadataFilters(searchParams),
    [searchParams],
  );
  const page = Math.max(
    1,
    parseNonNegativeInt(searchParams.get('page')) ?? 1,
  );
  const pageSize = parsePageSize(searchParams.get('pageSize'));
  // KS-2143: keyset cursor читается из URL. На первой странице
  // отсутствует. На последующих кладётся при клике Next; reload
  // `?page=N&cursor=<opaque>` восстанавливает ту же позицию.
  const cursor = searchParams.get('cursor') ?? undefined;

  const [data, setData] = useState<ArchiveGamesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // KS-2143: cursor-стек в SPA-памяти. Map page-number → cursor,
  // который ВЁЛ к этой странице (т.е. cursor который мы передали в
  // запросе при загрузке этой страницы). pageCursorMap.get(1) всегда
  // undefined (page 1 без cursor). pageCursorMap.get(N) хранит
  // nextCursor возвращённый при загрузке page=N-1. Стек живёт только
  // в текущей сессии страницы — при reload очищается, и Prev опускается
  // на offset-fallback (через URL `?page=N`).
  const pageCursorMapRef = useRef<Map<number, string>>(new Map());

  const writeFilters = useCallback(
    (
      next: ArchiveMetadataFilterValues,
      nextPage: number,
      nextPageSize: number,
      nextCursor?: string,
    ) => {
      const params = metadataFiltersToUrl(
        next,
        nextPage,
        nextPageSize,
        nextCursor,
      );
      setSearchParams(params, { replace: true });
    },
    [setSearchParams],
  );

  const handleFiltersChange = useCallback(
    (next: ArchiveMetadataFilterValues) => {
      // KS-2068: смена фильтра сбрасывает страницу на 1 (offset=0).
      // KS-2143: и стек cursor'ов — старые cursor'ы относятся к
      // другому набору фильтров, бэк их «silently» проигнорирует
      // и отдаст 1-ю страницу, но логичнее очистить локально.
      pageCursorMapRef.current.clear();
      writeFilters(next, 1, pageSize);
    },
    [pageSize, writeFilters],
  );

  const handlePageSizeChange = useCallback(
    (size: number) => {
      // KS-2143: pageSize меняет «гранулярность» страниц — старые
      // cursor'ы считались под другим limit, могут быть «не на
      // границе». Сбрасываем стек, page=1.
      pageCursorMapRef.current.clear();
      writeFilters(filterValues, 1, size);
    },
    [filterValues, writeFilters],
  );

  const handlePrev = useCallback(() => {
    if (page <= 1) return;
    const prevPage = page - 1;
    // KS-2143: cursor для предыдущей страницы — из стека (если эта
    // страница была загружена в текущей сессии). Page=1 → cursor нет
    // вовсе. Если стек пуст (deep-link reload без сессии) — Prev уведёт
    // через offset-fallback.
    const prevCursor =
      prevPage <= 1 ? undefined : pageCursorMapRef.current.get(prevPage);
    writeFilters(filterValues, prevPage, pageSize, prevCursor);
  }, [filterValues, page, pageSize, writeFilters]);

  const handleNext = useCallback(() => {
    if (!data) return;
    // KS-2143: keyset-курсор. Если бэк отдал `nextCursor` (= `null` →
    // конца достигли) — переходим на следующую страницу с этим
    // cursor'ом. Стек пополняется. Backward-compat: если бэк ещё на
    // старом DTO без `nextCursor` (стадия 1, KS-2140) — пытаемся через
    // total/pageSize, иначе блокируем кнопку.
    let nextCursor: string | undefined;
    if (data.nextCursor) {
      nextCursor = data.nextCursor;
    } else if (data.nextCursor === null) {
      // явно null → конца достигли
      return;
    } else if (data.hasNext) {
      // старый бэк (без nextCursor): cursor undefined, fallback на offset
      nextCursor = undefined;
    } else if (data.total !== null && data.total > 0) {
      const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
      if (page >= totalPages) return;
      nextCursor = undefined;
    } else {
      return;
    }
    const nextPage = page + 1;
    if (nextCursor) pageCursorMapRef.current.set(nextPage, nextCursor);
    writeFilters(filterValues, nextPage, pageSize, nextCursor);
  }, [data, filterValues, page, pageSize, writeFilters]);

  const handleResetFilters = useCallback(() => {
    pageCursorMapRef.current.clear();
    writeFilters(EMPTY_METADATA_FILTERS, 1, pageSize);
  }, [pageSize, writeFilters]);

  const handleRowClick = useCallback(
    (item: { id: string }) => navigate(`/archive/games/${item.id}`),
    [navigate],
  );

  // ─── Загрузка ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    archiveApi
      .getArchiveGamesMetadata(
        metadataFiltersToRequest(filterValues, page, pageSize, cursor),
      )
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filterValues, page, pageSize, cursor]);

  const items: ArchiveGameSummary[] = data?.items ?? [];
  // KS-2141: `total` теперь nullable. `null` означает «бэк пропустил
  // COUNT(*)» (любой фильтр / non-recent sort / offset>0). Не делаем
  // подстановку 0 — она спутала бы UI с настоящим «нет партий».
  const total: number | null = data?.total ?? null;
  // totalPages считаем только когда total известен. Иначе — пагинация
  // через `hasNext`, без знания «последней страницы».
  const totalPages =
    total !== null && total > 0
      ? Math.max(1, Math.ceil(total / pageSize))
      : null;
  // KS-2141: `hasNext` — обязательное поле в новом DTO. Если бэк ещё
  // на старом формате (deploy окно: фронт может уехать раньше) и
  // прислал ответ без `hasNext`, fallback'имся к расчёту через total
  // (классическая offset-pagination), чтобы не блокировать пользователю
  // переход на следующую страницу.
  const hasNext =
    data?.hasNext ?? (totalPages !== null ? page < totalPages : false);

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
        </div>
      )}

      {/* Пагинация.
          KS-2135: оставляем видимой при наличии данных (даже если идёт
          перезапрос соседней страницы / смена sort / page-size) — кнопки
          уже `disabled={loading}`, но сама панель не должна мигать.
          KS-2141: pagination показываем при `items.length > 0` ИЛИ
          когда total>0 (cached recent). При `total === null` нет «Page
          N / total», только «Page N»; «Next» управляется `hasNext`. */}
      {(items.length > 0 || (total !== null && total > 0)) && (
        <nav
          className="archive-games-metadata__pagination"
          data-testid="archive-games-metadata-pagination"
          aria-label={t('games.metadata.paginationLabel', 'Pagination')}
        >
          <button
            type="button"
            data-testid="archive-games-metadata-prev"
            onClick={handlePrev}
            disabled={page <= 1 || loading}
          >
            ← {t('games.metadata.prev', 'Prev')}
          </button>
          <span
            className="archive-games-metadata__page-info"
            data-testid="archive-games-metadata-page-info"
          >
            {totalPages !== null
              ? t('games.metadata.pageInfo', {
                  defaultValue: 'Page {{page}} / {{total}}',
                  page,
                  total: totalPages,
                })
              : // KS-2141: total неизвестен (skipTotal на бэке) — показываем
                // только «Page N», без «/ N» (нет данных для последней
                // страницы, не врём пользователю).
                t('games.metadata.pageInfoNoTotal', {
                  defaultValue: 'Page {{page}}',
                  page,
                })}
          </span>
          <button
            type="button"
            data-testid="archive-games-metadata-next"
            onClick={handleNext}
            disabled={!hasNext || loading}
          >
            {t('games.metadata.next', 'Next')} →
          </button>

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
        </nav>
      )}
    </div>
  );
}
