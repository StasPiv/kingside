import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { PuzzleGeneratorModal } from '../components/PuzzleGeneratorModal';
import { HelpButton } from '../components/HelpButton';
import {
  useInfinitePuzzles,
  type BrowsePuzzleDto,
} from '../hooks/useInfinitePuzzles';

/**
 * KS-2561 (ADR — bury old offset/sort): новый `/puzzles` с
 *  - бесконечной прокруткой по cursor (`/puzzles/browse?cursor=…`),
 *  - фильтрами рейтинг/темы (URL-state),
 *  - карточками-диаграммами (FEN, без чипов/имени).
 *
 * Старая offset-пагинация и сортировки удалены (KS-2560 backend).
 *
 * Acceptance — см. KS-2561; точки расширения комментированы по месту.
 */

/** Минимальный размер страницы (KS-2560 backend default — 30). */
const PAGE_SIZE = 30;

/**
 * Whitelist тем для multiselect-фильтра. Покрывает основные lichess-
 * категории, под которые есть переводы в `puzzleBrowser.themes.*`.
 * Имена сырые camelCase — это API-ключи (`puzzles.themes` массив).
 * Список умышленно компактный: иначе UI чипов перегружается. Легко
 * расширяется массивом ниже.
 */
const THEME_FILTER_WHITELIST: readonly string[] = [
  'mateIn1',
  'mateIn2',
  'mateIn3',
  'fork',
  'pin',
  'skewer',
  'sacrifice',
  'discoveredAttack',
  'doubleCheck',
  'hangingPiece',
  'attraction',
  'deflection',
  'kingsideAttack',
  'queensideAttack',
  'endgame',
  'opening',
  'middlegame',
  'rookEndgame',
  'queenEndgame',
  'pawnEndgame',
  'smotheredMate',
  'trappedPiece',
  'advancedPawn',
];

/** Ограничители рейтинга — не позволяем юзеру ввести сильно за разумные. */
const RATING_MIN_BOUND = 400;
const RATING_MAX_BOUND = 3200;

/** Сторона на ходу из FEN (для иконки на карточке). */
function sideFromFen(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

interface FilterState {
  ratingMin: number | null;
  ratingMax: number | null;
  themes: string[];
  mine: boolean;
  hideSolved: boolean;
}

function readFiltersFromUrl(params: URLSearchParams): FilterState {
  const parseRating = (v: string | null): number | null => {
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(RATING_MIN_BOUND, Math.min(RATING_MAX_BOUND, Math.round(n)));
  };
  const themesRaw = params.get('themes') ?? '';
  return {
    ratingMin: parseRating(params.get('ratingMin')),
    ratingMax: parseRating(params.get('ratingMax')),
    themes: themesRaw
      ? themesRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
    mine: params.get('mine') === 'true',
    hideSolved: params.get('hideSolved') !== 'false', // default true
  };
}

function writeFiltersToUrl(filters: FilterState): URLSearchParams {
  const next = new URLSearchParams();
  if (filters.ratingMin != null)
    next.set('ratingMin', String(filters.ratingMin));
  if (filters.ratingMax != null)
    next.set('ratingMax', String(filters.ratingMax));
  if (filters.themes.length > 0) next.set('themes', filters.themes.join(','));
  if (filters.mine) next.set('mine', 'true');
  // hideSolved дефолт=true: пишем в URL только если выключено (false).
  if (!filters.hideSolved) next.set('hideSolved', 'false');
  return next;
}

export function PuzzleBrowserPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [filters, setFilters] = useState<FilterState>(() =>
    readFiltersFromUrl(searchParams),
  );

  // Sync URL ← filters (без navigation, replace).
  useEffect(() => {
    const next = writeFiltersToUrl(filters);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const filtersForHook = useMemo(
    () => ({
      ratingMin: filters.ratingMin ?? undefined,
      ratingMax: filters.ratingMax ?? undefined,
      themes: filters.themes,
      mine: filters.mine,
      hideSolved: user ? filters.hideSolved : false,
      limit: PAGE_SIZE,
    }),
    [filters, user],
  );

  const {
    puzzles,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    removeLocally,
    patchLocally,
  } = useInfinitePuzzles(filtersForHook);

  // IntersectionObserver — догружает следующую страницу когда sentinel
  // показывается. Стабильная ссылка на loadMore через ref избегает
  // пересоздания observer'а на каждый рендер.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: '300px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const [showGenerator, setShowGenerator] = useState(false);

  const updateFilters = useCallback(
    (patch: Partial<FilterState>) => {
      setFilters((prev) => ({ ...prev, ...patch }));
    },
    [],
  );

  const toggleTheme = useCallback(
    (theme: string) => {
      setFilters((prev) => {
        const has = prev.themes.includes(theme);
        return {
          ...prev,
          themes: has
            ? prev.themes.filter((t) => t !== theme)
            : [...prev.themes, theme],
        };
      });
    },
    [],
  );

  const resetFilters = useCallback(() => {
    setFilters({
      ratingMin: null,
      ratingMax: null,
      themes: [],
      mine: false,
      hideSolved: true,
    });
  }, []);

  return (
    <div
      className="puzzle-browser-page"
      data-testid="puzzle-browser-page"
      data-state={loading ? 'loading' : error ? 'error' : 'ready'}
    >
      <h1>
        {t('puzzleBrowser.title')}
        <HelpButton section="puzzles" />
      </h1>

      {/* Tabs */}
      <div className="puzzle-browser-tabs">
        <button
          type="button"
          className={`puzzle-browser-tab${!filters.mine ? ' active' : ''}`}
          onClick={() => updateFilters({ mine: false })}
        >
          {t('puzzleBrowser.allPuzzles', 'All puzzles')}
        </button>
        {user && (
          <button
            type="button"
            className={`puzzle-browser-tab${filters.mine ? ' active' : ''}`}
            onClick={() => updateFilters({ mine: true })}
          >
            {t('puzzleBrowser.myPuzzles', 'My puzzles')}
          </button>
        )}
        {user && (
          <Link to="/puzzles/stats" className="puzzle-browser-tab">
            {t('puzzleStats.title', 'Statistics')}
          </Link>
        )}
      </div>

      {/* Filters */}
      <div
        className="puzzle-filters"
        data-testid="puzzle-filters"
        role="group"
        aria-label={t('puzzleBrowser.filtersLabel', 'Filters')}
      >
        <div className="puzzle-filters__rating">
          <label className="puzzle-filters__field">
            <span className="puzzle-filters__field-label">
              {t('puzzleBrowser.ratingMin', 'Rating min')}
            </span>
            <input
              type="number"
              inputMode="numeric"
              data-testid="filter-rating-min"
              min={RATING_MIN_BOUND}
              max={RATING_MAX_BOUND}
              value={filters.ratingMin ?? ''}
              placeholder={String(RATING_MIN_BOUND)}
              onChange={(e) => {
                const v = e.target.value.trim();
                updateFilters({
                  ratingMin: v ? Math.round(Number(v)) : null,
                });
              }}
            />
          </label>
          <label className="puzzle-filters__field">
            <span className="puzzle-filters__field-label">
              {t('puzzleBrowser.ratingMax', 'Rating max')}
            </span>
            <input
              type="number"
              inputMode="numeric"
              data-testid="filter-rating-max"
              min={RATING_MIN_BOUND}
              max={RATING_MAX_BOUND}
              value={filters.ratingMax ?? ''}
              placeholder={String(RATING_MAX_BOUND)}
              onChange={(e) => {
                const v = e.target.value.trim();
                updateFilters({
                  ratingMax: v ? Math.round(Number(v)) : null,
                });
              }}
            />
          </label>
          {user && (
            <label className="puzzle-filters__hide-solved">
              <input
                type="checkbox"
                data-testid="filter-hide-solved"
                checked={filters.hideSolved}
                onChange={(e) =>
                  updateFilters({ hideSolved: e.target.checked })
                }
              />
              {t('puzzleBrowser.hideSolved', 'Hide solved')}
            </label>
          )}
          <button
            type="button"
            className="puzzle-filters__reset"
            data-testid="filter-reset"
            onClick={resetFilters}
          >
            {t('puzzleBrowser.resetFilters', 'Reset')}
          </button>
          <button
            type="button"
            className="generate-puzzles-btn"
            onClick={() => setShowGenerator(true)}
          >
            {t('puzzleGenerator.fromPgn', 'Generate from PGN')}
          </button>
        </div>
        <div
          className="puzzle-filters__themes"
          data-testid="filter-themes"
        >
          {THEME_FILTER_WHITELIST.map((theme) => {
            const active = filters.themes.includes(theme);
            return (
              <button
                key={theme}
                type="button"
                className={`puzzle-filters__theme-chip${active ? ' active' : ''}`}
                data-testid={`filter-theme-${theme}`}
                data-active={active ? 'true' : 'false'}
                onClick={() => toggleTheme(theme)}
              >
                {t(`puzzleBrowser.themes.${theme}`, theme) as string}
              </button>
            );
          })}
        </div>
      </div>

      {/* List / states */}
      {loading && puzzles.length === 0 ? (
        <div className="loading" data-testid="puzzle-browser-loading">
          {t('common.loading')}
        </div>
      ) : error ? (
        <div className="puzzle-empty" data-testid="puzzle-browser-error">
          <p>{t('puzzleBrowser.loadError', 'Failed to load puzzles')}</p>
        </div>
      ) : puzzles.length === 0 ? (
        <div className="puzzle-empty" data-testid="puzzle-browser-empty">
          <p>
            {t(
              'puzzleBrowser.empty',
              'No puzzles match the selected filters',
            )}
          </p>
        </div>
      ) : (
        <div className="puzzle-grid" data-testid="puzzle-grid">
          {puzzles.map((p) => (
            <PuzzleDiagramCard
              key={p.id}
              puzzle={p}
              ownedByMe={p.userId != null && p.userId === user?.id}
              onOpen={() => navigate(`/puzzle/${p.id}`)}
              onTogglePublic={async () => {
                try {
                  await api.patch(`/puzzles/${p.id}`, {
                    isPublic: !p.isPublic,
                  });
                  patchLocally(p.id, { isPublic: !p.isPublic });
                } catch {
                  /* ignore */
                }
              }}
              onDelete={async () => {
                try {
                  await api.delete(`/puzzles/${p.id}`);
                  removeLocally(p.id);
                } catch {
                  /* ignore */
                }
              }}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Sentinel + loading-more индикатор. */}
      <div
        ref={sentinelRef}
        className="puzzle-browser-sentinel"
        data-testid="puzzle-browser-sentinel"
        aria-hidden="true"
      />
      {loadingMore && (
        <div
          className="puzzle-browser-loading-more"
          data-testid="puzzle-browser-loading-more"
        >
          {t('common.loading')}
        </div>
      )}
      {!loading && !hasMore && puzzles.length > 0 && (
        <div
          className="puzzle-browser-end"
          data-testid="puzzle-browser-end"
        >
          {t('puzzleBrowser.endOfList', 'No more puzzles.')}
        </div>
      )}

      {showGenerator && (
        <PuzzleGeneratorModal
          onClose={() => {
            setShowGenerator(false);
          }}
        />
      )}
    </div>
  );
}

interface PuzzleDiagramCardProps {
  puzzle: BrowsePuzzleDto;
  ownedByMe: boolean;
  onOpen: () => void;
  onTogglePublic: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}

/**
 * Карточка-диаграмма: FEN-доска + рейтинг + индикатор стороны хода.
 * Без чипов тем (KS-2554) и без имён — диаграмма информативнее.
 */
function PuzzleDiagramCard({
  puzzle,
  ownedByMe,
  onOpen,
  onTogglePublic,
  onDelete,
  t,
}: PuzzleDiagramCardProps) {
  const orientation = sideFromFen(puzzle.fen);
  const solvedCls =
    puzzle.solvedStatus === 'solved'
      ? ' puzzle-card--solved'
      : puzzle.solvedStatus === 'failed'
        ? ' puzzle-card--failed'
        : '';
  return (
    <article
      className={`puzzle-card${solvedCls}`}
      data-testid="puzzle-card"
      data-puzzle-id={puzzle.id}
    >
      <button
        type="button"
        className="puzzle-card__board-btn"
        data-testid="puzzle-card-board"
        onClick={onOpen}
        aria-label={t('puzzleBrowser.openPuzzle', 'Open puzzle')}
      >
        <Chessboard
          options={{
            position: puzzle.fen,
            boardOrientation: orientation,
            animationDurationInMs: 0,
            allowDragging: false,
            showNotation: false,
          }}
        />
      </button>
      <div className="puzzle-card__meta">
        <span
          className="puzzle-card__rating"
          data-testid="puzzle-card-rating"
        >
          {puzzle.rating}
        </span>
        <span
          className="puzzle-card__side"
          data-testid="puzzle-card-side"
          data-side={orientation}
          aria-label={
            orientation === 'white'
              ? t('drills.side.whiteToMove', 'White to move')
              : t('drills.side.blackToMove', 'Black to move')
          }
        >
          {orientation === 'white' ? '♔' : '♚'}
        </span>
        {puzzle.solvedStatus === 'solved' && (
          <span className="puzzle-card__status puzzle-card__status--solved">
            ✓
          </span>
        )}
        {puzzle.solvedStatus === 'failed' && (
          <span className="puzzle-card__status puzzle-card__status--failed">
            ✗
          </span>
        )}
      </div>
      {ownedByMe && (
        <div className="puzzle-card__owner-actions">
          <button
            type="button"
            className={`puzzle-share-btn${puzzle.isPublic ? ' shared' : ''}`}
            data-testid="puzzle-card-share"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePublic();
            }}
            title={
              puzzle.isPublic
                ? t('puzzleBrowser.unpublish', 'Make private')
                : t('puzzleBrowser.publish', 'Publish')
            }
          >
            {puzzle.isPublic ? '🌐' : '🔒'}
          </button>
          <button
            type="button"
            className="puzzle-delete-btn"
            data-testid="puzzle-card-delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title={t('common.delete', 'Delete')}
          >
            ×
          </button>
        </div>
      )}
    </article>
  );
}
