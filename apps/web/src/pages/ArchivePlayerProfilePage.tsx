import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  ArchiveGameResult,
  ArchivePlayerGameItem,
  ArchivePlayerGamesRequest,
  ArchivePlayerGamesResponse,
  ArchivePlayerProfile,
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

/**
 * KS-2069 (F3 / ADR-033 §1 S5, §6.3): профиль игрока архива партий.
 *
 * Маршрут `/archive/players/:slug`. На mount грузим:
 *   - `archiveApi.getArchivePlayerProfile(slug)` — header профиля
 *     (имя, peak Elo, byColor/byResult, период активности).
 *   - `archiveApi.getArchivePlayerGames(slug, filters)` — список партий
 *     с фильтрами + доп. фильтр `color: white|black|any`.
 *
 * URL — единственный источник истины для фильтров и пагинации
 * (deep-link воспроизводит состояние). Большую часть filter-логики
 * переиспользуем из metadata-режима F2 (`ArchiveMetadataFilters` +
 * `EMPTY_METADATA_FILTERS`), добавляя `playerColor` отдельно поверх.
 *
 * 404 — отдельный экран с возвратом на `/archive`.
 */

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const SKELETON_ROWS = 10;

type PlayerColorFilter = 'any' | 'white' | 'black';

const VALID_COLORS: readonly PlayerColorFilter[] = ['any', 'white', 'black'];

function parseColor(raw: string | null): PlayerColorFilter {
  return VALID_COLORS.includes(raw as PlayerColorFilter)
    ? (raw as PlayerColorFilter)
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

const VALID_RESULTS: readonly MetadataResultFilter[] = [
  'any',
  '1-0',
  '0-1',
  '1/2-1/2',
];

function parseResult(raw: string | null): MetadataResultFilter {
  return VALID_RESULTS.includes(raw as MetadataResultFilter)
    ? (raw as MetadataResultFilter)
    : 'any';
}

function parseSort(raw: string | null): 'recent' | 'topElo' | 'oldest' {
  return raw === 'topElo' || raw === 'oldest' ? raw : 'recent';
}

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

interface UrlState {
  filters: ArchiveMetadataFilterValues;
  color: PlayerColorFilter;
  page: number;
  pageSize: number;
}

/**
 * URL → state. Невалидные значения откатываются к дефолтам.
 * Экспортируется для unit-тестов.
 */
export function urlToPlayerState(params: URLSearchParams): UrlState {
  return {
    filters: {
      // KS-2084: на странице игрока фильтр по другим игрокам не имеет
      // смысла (профиль = один игрок), поэтому players всегда пустой.
      players: [],
      event: params.get('event') ?? '',
      eco: params.get('eco') ?? '',
      result: parseResult(params.get('result')),
      minElo: parseNonNegativeInt(params.get('minElo')),
      since: params.get('since') ?? '',
      until: params.get('until') ?? '',
      minPly: parseNonNegativeInt(params.get('minPly')),
      maxPly: parseNonNegativeInt(params.get('maxPly')),
      sort: parseSort(params.get('sort')),
      // KS-2115: множественный фильтр контроля времени.
      timeControlCategory: parseTimeControlCategories(
        params.getAll('timeControlCategory'),
      ),
    },
    color: parseColor(params.get('color')),
    page: Math.max(1, parseNonNegativeInt(params.get('page')) ?? 1),
    pageSize: parsePageSize(params.get('pageSize')),
  };
}

/**
 * State → URL. Дефолты опускаются, чтобы URL оставался чистым.
 * Экспортируется для unit-тестов.
 */
export function playerStateToUrl(state: UrlState): URLSearchParams {
  const { filters, color, page, pageSize } = state;
  const params = new URLSearchParams();
  if (filters.event) params.set('event', filters.event);
  if (filters.eco) params.set('eco', filters.eco);
  if (filters.result !== 'any') params.set('result', filters.result);
  if (filters.minElo !== null) params.set('minElo', String(filters.minElo));
  if (filters.since) params.set('since', filters.since);
  if (filters.until) params.set('until', filters.until);
  if (filters.minPly !== null) params.set('minPly', String(filters.minPly));
  if (filters.maxPly !== null) params.set('maxPly', String(filters.maxPly));
  if (filters.sort !== 'recent') params.set('sort', filters.sort);
  // KS-2115: каждый элемент массива — отдельный append.
  for (const cat of filters.timeControlCategory) {
    params.append('timeControlCategory', cat);
  }
  if (color !== 'any') params.set('color', color);
  if (page > 1) params.set('page', String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE)
    params.set('pageSize', String(pageSize));
  return params;
}

/**
 * State → request для `getArchivePlayerGames`. Slug передаётся
 * отдельным аргументом — в `Omit<ArchivePlayerGamesRequest, 'slug'>`.
 */
export function playerStateToRequest(
  state: UrlState,
): Omit<ArchivePlayerGamesRequest, 'slug'> {
  const { filters, color, page, pageSize } = state;
  return {
    color,
    result:
      filters.result === 'any'
        ? undefined
        : (filters.result as ArchiveGameResult),
    eco: filters.eco || undefined,
    event: filters.event || undefined,
    minElo: filters.minElo ?? undefined,
    since: filters.since || undefined,
    until: filters.until || undefined,
    minPly: filters.minPly ?? undefined,
    maxPly: filters.maxPly ?? undefined,
    sort: filters.sort,
    // KS-2115.
    timeControlCategory:
      filters.timeControlCategory.length === 0
        ? undefined
        : filters.timeControlCategory.length === 1
          ? filters.timeControlCategory[0]
          : filters.timeControlCategory,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  // Принимаем ISO или PGN-формат "YYYY.MM.DD" — в любом случае берём
  // первый блок дат-разделителей и приводим к человеческому виду.
  const m = /^(\d{4})[-./](\d{2})[-./](\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

export function ArchivePlayerProfilePage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation('archive');
  const [searchParams, setSearchParams] = useSearchParams();

  const state = useMemo(
    () => urlToPlayerState(searchParams),
    [searchParams],
  );

  const [profile, setProfile] = useState<ArchivePlayerProfile | null>(null);
  const [profileError, setProfileError] = useState<
    'not_found' | 'load_error' | null
  >(null);
  const [profileLoading, setProfileLoading] = useState(true);

  const [games, setGames] = useState<ArchivePlayerGamesResponse | null>(null);
  const [gamesLoading, setGamesLoading] = useState(true);
  const [gamesError, setGamesError] = useState<string | null>(null);

  // ─── Загрузка профиля ────────────────────────────────────────────
  useEffect(() => {
    if (!slug) {
      setProfileError('not_found');
      setProfileLoading(false);
      return;
    }
    let cancelled = false;
    setProfileLoading(true);
    setProfileError(null);
    setProfile(null);
    archiveApi
      .getArchivePlayerProfile(slug)
      .then((res) => {
        if (cancelled) return;
        setProfile(res);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        const isNotFound = /\b404\b|not\s*found/i.test(e.message);
        setProfileError(isNotFound ? 'not_found' : 'load_error');
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // ─── Загрузка партий ─────────────────────────────────────────────
  // KS-2069: запускаем ТОЛЬКО когда профиль успешно загрузился. Если
  // профиль отдал 404/load_error — список партий показывать незачем,
  // и лишний запрос только засоряет network.
  useEffect(() => {
    if (!slug || !profile) return;
    let cancelled = false;
    setGamesLoading(true);
    setGamesError(null);
    archiveApi
      .getArchivePlayerGames(slug, playerStateToRequest(state))
      .then((res) => {
        if (cancelled) return;
        setGames(res);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setGamesError(e.message);
      })
      .finally(() => {
        if (!cancelled) setGamesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, state, profile]);

  // ─── Хелперы для записи URL ──────────────────────────────────────
  const writeState = useCallback(
    (next: UrlState) => {
      setSearchParams(playerStateToUrl(next), { replace: true });
    },
    [setSearchParams],
  );

  const handleFiltersChange = useCallback(
    (nextFilters: ArchiveMetadataFilterValues) => {
      // Смена фильтра сбрасывает page=1 (offset=0).
      writeState({ ...state, filters: nextFilters, page: 1 });
    },
    [state, writeState],
  );

  const handleColorChange = useCallback(
    (next: PlayerColorFilter) => {
      writeState({ ...state, color: next, page: 1 });
    },
    [state, writeState],
  );

  const handlePageSizeChange = useCallback(
    (size: number) => {
      writeState({ ...state, pageSize: size, page: 1 });
    },
    [state, writeState],
  );

  const handlePrev = useCallback(() => {
    if (state.page <= 1) return;
    writeState({ ...state, page: state.page - 1 });
  }, [state, writeState]);

  const handleNext = useCallback(() => {
    const total = games?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page >= totalPages) return;
    writeState({ ...state, page: state.page + 1 });
  }, [games, state, writeState]);

  const handleResetFilters = useCallback(() => {
    writeState({
      filters: EMPTY_METADATA_FILTERS,
      color: 'any',
      page: 1,
      pageSize: state.pageSize,
    });
  }, [state.pageSize, writeState]);

  const handleRowClick = useCallback(
    (item: { id: string }) => navigate(`/archive/games/${item.id}`),
    [navigate],
  );

  // ─── 404 ─────────────────────────────────────────────────────────
  if (profileError === 'not_found') {
    return (
      <div
        className="archive-page archive-player-profile-page"
        data-testid="archive-player-profile-page"
        data-state="not-found"
      >
        <h1>{t('player.notFound.title', 'Player not found')}</h1>
        <p>
          {t(
            'player.notFound.description',
            'No player matches this URL. They may have been removed from the archive.',
          )}
        </p>
        <Link
          className="archive-player-profile-page__back"
          to="/archive"
          data-testid="archive-player-profile-back"
        >
          ← {t('player.notFound.backToArchive', 'Back to archive')}
        </Link>
      </div>
    );
  }

  if (profileLoading || !profile) {
    return (
      <div
        className="archive-page archive-player-profile-page"
        data-testid="archive-player-profile-page"
        data-state={profileError === 'load_error' ? 'error' : 'loading'}
      >
        {profileError === 'load_error' ? (
          <p>
            {t(
              'player.loadError',
              'Failed to load player profile. Try refreshing the page.',
            )}
          </p>
        ) : (
          <p>{t('player.loading', 'Loading player profile…')}</p>
        )}
      </div>
    );
  }

  // ─── Расчёты для header'а ───────────────────────────────────────
  const totalResults =
    profile.byResult.wins + profile.byResult.draws + profile.byResult.losses;
  const winsPct = pct(profile.byResult.wins, totalResults);
  const drawsPct = pct(profile.byResult.draws, totalResults);
  const lossesPct = pct(profile.byResult.losses, totalResults);
  const totalColorGames = profile.byColor.white + profile.byColor.black;
  const whitePct = pct(profile.byColor.white, totalColorGames);
  const blackPct = pct(profile.byColor.black, totalColorGames);

  const items: ArchivePlayerGameItem[] = games?.items ?? [];
  const total = games?.total ?? 0;
  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / state.pageSize)) : 1;

  const hasActiveFilters =
    state.color !== 'any' ||
    state.filters.event !== '' ||
    state.filters.eco !== '' ||
    state.filters.result !== 'any' ||
    state.filters.minElo !== null ||
    state.filters.since !== '' ||
    state.filters.until !== '' ||
    state.filters.minPly !== null ||
    state.filters.maxPly !== null ||
    state.filters.timeControlCategory.length > 0;

  return (
    <div
      className="archive-page archive-player-profile-page"
      data-testid="archive-player-profile-page"
      data-state="ready"
      data-slug={profile.slug}
    >
      <header className="archive-player-profile-page__header">
        <div className="archive-player-profile-page__title-row">
          <h1
            className="archive-player-profile-page__name"
            data-testid="archive-player-profile-name"
          >
            {profile.name}
          </h1>
          <Link
            to="/archive"
            className="archive-player-profile-page__back"
            data-testid="archive-player-profile-back"
          >
            ← {t('player.backToArchive', 'Back to archive')}
          </Link>
        </div>

        <dl className="archive-player-profile-page__stats">
          <div>
            <dt>{t('player.gamesCount', 'Games')}</dt>
            <dd data-testid="archive-player-profile-games-count">
              {profile.gamesCount}
            </dd>
          </div>
          <div>
            <dt>{t('player.peakElo', 'Peak Elo')}</dt>
            <dd data-testid="archive-player-profile-peak-elo">
              {profile.peakElo ?? '—'}
            </dd>
          </div>
          <div>
            <dt>{t('player.activePeriod', 'Active period')}</dt>
            <dd data-testid="archive-player-profile-period">
              {formatDate(profile.firstSeenAt)} — {formatDate(profile.lastSeenAt)}
            </dd>
          </div>
        </dl>

        {/* Распределение по цвету */}
        <div
          className="archive-player-profile-page__by-color"
          data-testid="archive-player-profile-by-color"
        >
          <span>
            {t('player.byColor.white', {
              defaultValue: 'White: {{count}} ({{percent}}%)',
              count: profile.byColor.white,
              percent: whitePct,
            })}
          </span>
          <span>
            {t('player.byColor.black', {
              defaultValue: 'Black: {{count}} ({{percent}}%)',
              count: profile.byColor.black,
              percent: blackPct,
            })}
          </span>
        </div>

        {/* Распределение по результату — визуальный bar */}
        <div
          className="archive-player-profile-page__by-result"
          data-testid="archive-player-profile-by-result"
          aria-label={t(
            'player.byResult.barLabel',
            'Result distribution: wins/draws/losses',
          )}
        >
          <div
            className="archive-player-profile-page__by-result-bar"
            role="img"
            aria-hidden="true"
          >
            <span
              className="archive-player-profile-page__by-result-segment archive-player-profile-page__by-result-segment--win"
              style={{ width: `${winsPct}%` }}
              data-testid="archive-player-profile-by-result-win"
            />
            <span
              className="archive-player-profile-page__by-result-segment archive-player-profile-page__by-result-segment--draw"
              style={{ width: `${drawsPct}%` }}
              data-testid="archive-player-profile-by-result-draw"
            />
            <span
              className="archive-player-profile-page__by-result-segment archive-player-profile-page__by-result-segment--loss"
              style={{ width: `${lossesPct}%` }}
              data-testid="archive-player-profile-by-result-loss"
            />
          </div>
          <div className="archive-player-profile-page__by-result-legend">
            <span>
              {t('player.byResult.wins', {
                defaultValue: 'Wins: {{count}} ({{percent}}%)',
                count: profile.byResult.wins,
                percent: winsPct,
              })}
            </span>
            <span>
              {t('player.byResult.draws', {
                defaultValue: 'Draws: {{count}} ({{percent}}%)',
                count: profile.byResult.draws,
                percent: drawsPct,
              })}
            </span>
            <span>
              {t('player.byResult.losses', {
                defaultValue: 'Losses: {{count}} ({{percent}}%)',
                count: profile.byResult.losses,
                percent: lossesPct,
              })}
            </span>
          </div>
        </div>
      </header>

      {/* Фильтры */}
      <div className="archive-player-profile-page__filters-row">
        {/* Color — отдельно, потому что общий ArchiveMetadataFilters его не имеет. */}
        <label className="archive-games-filters__field">
          <span className="archive-games-filters__label">
            {t('player.colorLabel', 'Plays as')}
          </span>
          <select
            className="archive-games-filters__select"
            value={state.color}
            onChange={(e) =>
              handleColorChange(e.target.value as PlayerColorFilter)
            }
            data-testid="archive-player-filter-color"
          >
            <option value="any">{t('player.colorAny', 'Any colour')}</option>
            <option value="white">{t('player.colorWhite', 'White')}</option>
            <option value="black">{t('player.colorBlack', 'Black')}</option>
          </select>
        </label>

        <ArchiveMetadataFilters
          values={state.filters}
          onChange={handleFiltersChange}
        />
      </div>

      {/* Список */}
      {gamesLoading && items.length === 0 && (
        <div
          className="archive-games-list archive-games-list--loading"
          data-testid="archive-player-profile-skeleton"
        >
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className="archive-games-list__skeleton-row" />
          ))}
        </div>
      )}

      {!gamesLoading && gamesError && items.length === 0 && (
        <div
          className="archive-games-list archive-games-list--error"
          data-testid="archive-player-profile-games-error"
        >
          <span>{t('player.games.error', 'Failed to load games')}</span>
        </div>
      )}

      {!gamesLoading && !gamesError && items.length === 0 && (
        <div
          className="archive-games-list archive-games-list--empty"
          data-testid="archive-player-profile-games-empty"
        >
          <p>{t('player.games.empty', 'No games match these filters.')}</p>
          {hasActiveFilters && (
            <button
              type="button"
              className="archive-games-list__reset-filters"
              onClick={handleResetFilters}
              data-testid="archive-player-profile-reset-filters"
            >
              {t('player.games.resetFilters', 'Reset filters')}
            </button>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div
          className="archive-games-list"
          data-testid="archive-player-profile-games-list"
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

      {items.length > 0 && (
        <nav
          className="archive-games-metadata__pagination"
          data-testid="archive-player-profile-pagination"
          aria-label={t('player.games.paginationLabel', 'Pagination')}
        >
          <button
            type="button"
            data-testid="archive-player-profile-prev"
            onClick={handlePrev}
            disabled={state.page <= 1 || gamesLoading}
          >
            ← {t('player.games.prev', 'Prev')}
          </button>
          <span
            className="archive-games-metadata__page-info"
            data-testid="archive-player-profile-page-info"
          >
            {t('player.games.pageInfo', {
              defaultValue: 'Page {{page}} / {{total}}',
              page: state.page,
              total: totalPages,
            })}
          </span>
          <button
            type="button"
            data-testid="archive-player-profile-next"
            onClick={handleNext}
            disabled={state.page >= totalPages || gamesLoading}
          >
            {t('player.games.next', 'Next')} →
          </button>

          <label className="archive-games-metadata__page-size">
            <span>{t('player.games.pageSizeLabel', 'Per page')}</span>
            <select
              data-testid="archive-player-profile-page-size"
              value={state.pageSize}
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
