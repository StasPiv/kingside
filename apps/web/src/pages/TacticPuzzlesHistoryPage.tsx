/**
 * KS-4359 / ADR-136 T7. Страница `/tactic-puzzles/history` — список
 * истории попыток текущего пользователя.
 *
 * Источник данных: `GET /tactic-puzzles/attempts` (KS-4356), хук
 * `useInfiniteTacticAttempts` (cursor-пагинация).
 *
 * Раскладка по образцу `PrecisionHistoryPage` (KS-2745):
 *   - `<TacticPuzzlesSubNav />` сверху (активный пункт «История»);
 *   - заголовок с CTA «Начать тренировку → /tactic-puzzles»;
 *   - блок фильтров (период / исход / stopReason / диапазон рейтинга);
 *   - список карточек попыток с мини-доской, метаданными и переходом
 *     на разбор (страница появится в T9 KS-43xx).
 *
 * Гостям эндпоинт `/tactic-puzzles/attempts` вернёт 401 — показываем
 * блок с приглашением войти.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import type {
  TacticAttemptListItem,
  TacticStopReason,
} from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { PageSeo } from '../components/seo/PageSeo';
import { TacticPuzzlesSubNav } from '../components/tactic-puzzles/TacticPuzzlesSubNav';
import { useInfiniteTacticAttempts } from '../hooks/useInfiniteTacticAttempts';
import type { ListTacticAttemptsQuery } from '../api/api-tactic-puzzle';

const LIMIT = 30;

type PeriodPreset = 'today' | 'week' | 'month' | 'all';
type OutcomeFilter = 'all' | 'solved' | 'failed';

const STOP_REASONS: readonly TacticStopReason[] = [
  'easy',
  'mate',
  'mistake',
  'timeout',
  'aborted',
];

function sideFromFen(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

/**
 * KS-4359. Период → ISO-границы `from`. Для предустановки `all`
 * фильтр не передаётся.
 */
function periodToFromIso(period: PeriodPreset): string | undefined {
  if (period === 'all') return undefined;
  const now = new Date();
  // День UTC начала текущих суток (для today / week / month).
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (period === 'today') return day.toISOString();
  if (period === 'week') {
    const d = new Date(day);
    d.setUTCDate(d.getUTCDate() - 6);
    return d.toISOString();
  }
  // month
  const d = new Date(day);
  d.setUTCDate(d.getUTCDate() - 29);
  return d.toISOString();
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function formatPlayedAt(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function TacticPuzzlesHistoryPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Фильтры из URL ──────────────────────────────────────────────
  const periodParam = (searchParams.get('period') ?? 'all') as PeriodPreset;
  const period: PeriodPreset =
    periodParam === 'today' ||
    periodParam === 'week' ||
    periodParam === 'month' ||
    periodParam === 'all'
      ? periodParam
      : 'all';

  const outcomeParam = (searchParams.get('outcome') ?? 'all') as OutcomeFilter;
  const outcome: OutcomeFilter =
    outcomeParam === 'all' ||
    outcomeParam === 'solved' ||
    outcomeParam === 'failed'
      ? outcomeParam
      : 'all';

  const stopReasonParam = searchParams.get('stopReason') ?? '';
  const stopReason: TacticStopReason | undefined =
    (STOP_REASONS as readonly string[]).includes(stopReasonParam)
      ? (stopReasonParam as TacticStopReason)
      : undefined;

  const ratingMinParam = searchParams.get('ratingMin');
  const ratingMaxParam = searchParams.get('ratingMax');
  const ratingMin =
    ratingMinParam && /^\d+$/.test(ratingMinParam)
      ? Math.max(0, parseInt(ratingMinParam, 10))
      : undefined;
  const ratingMax =
    ratingMaxParam && /^\d+$/.test(ratingMaxParam)
      ? Math.max(0, parseInt(ratingMaxParam, 10))
      : undefined;

  const filters = useMemo<ListTacticAttemptsQuery>(
    () => ({
      from: periodToFromIso(period),
      solved:
        outcome === 'solved' ? true : outcome === 'failed' ? false : undefined,
      stopReason,
      ratingMin,
      ratingMax,
      limit: LIMIT,
    }),
    [period, outcome, stopReason, ratingMin, ratingMax],
  );

  const { attempts, loading, loadingMore, error, hasMore, loadMore } =
    useInfiniteTacticAttempts(user ? filters : { limit: LIMIT });

  // ── Сетка фильтров: обновляем URL через searchParams ─────────────
  const setFilter = useCallback(
    (key: string, value: string | undefined) => {
      const sp = new URLSearchParams(searchParams);
      if (!value) sp.delete(key);
      else sp.set(key, value);
      setSearchParams(sp, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  const resetFilters = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: false });
  }, [setSearchParams]);

  const onRatingChange = useCallback(
    (key: 'ratingMin' | 'ratingMax') =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = e.target.value.replace(/\D/g, '');
        setFilter(key, v || undefined);
      },
    [setFilter],
  );

  // ── Sentinel для infinite scroll ────────────────────────────────
  const sentinelInViewRef = useRef(false);
  const sentinelObserverRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const setSentinelEl = useCallback((el: HTMLDivElement | null) => {
    if (sentinelObserverRef.current) {
      sentinelObserverRef.current.disconnect();
      sentinelObserverRef.current = null;
    }
    if (!el) {
      sentinelInViewRef.current = false;
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        const isVis = entries[0]?.isIntersecting ?? false;
        sentinelInViewRef.current = isVis;
        if (isVis) loadMoreRef.current();
      },
      { rootMargin: '400px' },
    );
    obs.observe(el);
    sentinelObserverRef.current = obs;
  }, []);
  useEffect(
    () => () => {
      sentinelObserverRef.current?.disconnect();
      sentinelObserverRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (loading || loadingMore) return;
    if (!hasMore) return;
    if (sentinelInViewRef.current) loadMoreRef.current();
  }, [loading, loadingMore, hasMore, attempts.length]);

  const isGuest = !user;
  const pageState: 'guest' | 'loading' | 'ready' | 'empty' | 'error' = isGuest
    ? 'guest'
    : loading
      ? 'loading'
      : error
        ? 'error'
        : attempts.length === 0
          ? 'empty'
          : 'ready';

  return (
    <div
      className="tactic-puzzles-history"
      data-testid="tactic-puzzles-history"
      data-auth={isGuest ? 'guest' : 'user'}
      data-state={pageState}
    >
      <PageSeo
        ns="tacticPuzzles.history"
        path="/tactic-puzzles/history"
        noindex
      />
      <TacticPuzzlesSubNav />

      <header className="tactic-puzzles-history__header">
        <h1>{t('tacticPuzzle.history.title', 'Attempt history')}</h1>
        <p className="tactic-puzzles-history__intro">
          {t(
            'tacticPuzzle.history.intro',
            'Every attempt you made in the Tactics section. Use the filters to narrow by date, outcome or rating range.',
          )}
        </p>
        <Link
          to="/tactic-puzzles"
          className="tactic-puzzles-history__start"
          data-testid="tactic-puzzles-history-start"
        >
          {t('tacticPuzzle.start', 'Start training')} →
        </Link>
      </header>

      {/* Фильтры скрыты гостю — данные всё равно недоступны. */}
      {!isGuest && (
        <section
          className="tactic-puzzles-history__filters"
          data-testid="tactic-puzzles-history-filters"
          aria-label={t('tacticPuzzle.history.filters.title', 'Filters')}
        >
          <div className="tactic-puzzles-history__filter-group">
            <span className="tactic-puzzles-history__filter-label">
              {t('tacticPuzzle.history.filters.period', 'Period')}
            </span>
            {(['today', 'week', 'month', 'all'] as const).map((key) => {
              const active = period === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={`tactic-puzzles-history__chip${
                    active ? ' tactic-puzzles-history__chip--active' : ''
                  }`}
                  data-testid={`tactic-puzzles-history-period-${key}`}
                  data-active={active ? 'true' : 'false'}
                  onClick={() =>
                    setFilter('period', key === 'all' ? undefined : key)
                  }
                >
                  {t(
                    `tacticPuzzle.history.filters.period${
                      key.charAt(0).toUpperCase() + key.slice(1)
                    }`,
                    key,
                  )}
                </button>
              );
            })}
          </div>

          <div className="tactic-puzzles-history__filter-group">
            <span className="tactic-puzzles-history__filter-label">
              {t('tacticPuzzle.history.filters.outcome', 'Outcome')}
            </span>
            {(['all', 'solved', 'failed'] as const).map((key) => {
              const active = outcome === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={`tactic-puzzles-history__chip${
                    active ? ' tactic-puzzles-history__chip--active' : ''
                  }`}
                  data-testid={`tactic-puzzles-history-outcome-${key}`}
                  data-active={active ? 'true' : 'false'}
                  onClick={() =>
                    setFilter('outcome', key === 'all' ? undefined : key)
                  }
                >
                  {t(
                    `tacticPuzzle.history.filters.outcome${
                      key.charAt(0).toUpperCase() + key.slice(1)
                    }`,
                    key,
                  )}
                </button>
              );
            })}
          </div>

          <div className="tactic-puzzles-history__filter-group">
            <span className="tactic-puzzles-history__filter-label">
              {t('tacticPuzzle.history.filters.stopReason', 'Stop reason')}
            </span>
            <button
              type="button"
              className={`tactic-puzzles-history__chip${
                !stopReason ? ' tactic-puzzles-history__chip--active' : ''
              }`}
              data-testid="tactic-puzzles-history-stop-all"
              onClick={() => setFilter('stopReason', undefined)}
            >
              {t('tacticPuzzle.history.filters.stopReasonAll', 'Any')}
            </button>
            {STOP_REASONS.map((reason) => {
              const active = stopReason === reason;
              return (
                <button
                  key={reason}
                  type="button"
                  className={`tactic-puzzles-history__chip${
                    active ? ' tactic-puzzles-history__chip--active' : ''
                  }`}
                  data-testid={`tactic-puzzles-history-stop-${reason}`}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => setFilter('stopReason', active ? undefined : reason)}
                >
                  {t(`tacticPuzzle.history.stopReason.${reason}`, reason)}
                </button>
              );
            })}
          </div>

          <div className="tactic-puzzles-history__filter-group">
            <span className="tactic-puzzles-history__filter-label">
              {t('tacticPuzzle.history.filters.rating', 'Rating')}
            </span>
            <input
              type="text"
              inputMode="numeric"
              className="tactic-puzzles-history__rating-input"
              placeholder={t('tacticPuzzle.history.filters.ratingMin', 'Min')}
              value={ratingMinParam ?? ''}
              onChange={onRatingChange('ratingMin')}
              data-testid="tactic-puzzles-history-rating-min"
            />
            <input
              type="text"
              inputMode="numeric"
              className="tactic-puzzles-history__rating-input"
              placeholder={t('tacticPuzzle.history.filters.ratingMax', 'Max')}
              value={ratingMaxParam ?? ''}
              onChange={onRatingChange('ratingMax')}
              data-testid="tactic-puzzles-history-rating-max"
            />
          </div>

          <button
            type="button"
            className="tactic-puzzles-history__reset"
            data-testid="tactic-puzzles-history-reset"
            onClick={resetFilters}
          >
            {t('tacticPuzzle.history.filters.reset', 'Reset')}
          </button>
        </section>
      )}

      {pageState === 'guest' && (
        <section
          className="tactic-puzzles-history__guest"
          data-testid="tactic-puzzles-history-guest"
        >
          <h2>{t('tacticPuzzle.history.guestTitle', 'Sign in to see history')}</h2>
          <p>
            {t(
              'tacticPuzzle.history.guestMessage',
              'Attempt history is available to signed-in players only.',
            )}
          </p>
          <Link to="/login" className="tactic-puzzles-history__guest-cta">
            {t('precision.history.guest.cta', 'Sign in')}
          </Link>
        </section>
      )}

      {pageState === 'loading' && (
        <p
          className="tactic-puzzles-history__status"
          data-testid="tactic-puzzles-history-loading"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}

      {pageState === 'error' && (
        <div
          className="tactic-puzzles-history__status tactic-puzzles-history__status--error"
          data-testid="tactic-puzzles-history-error"
        >
          <p>
            {t(
              'tacticPuzzle.history.loadError',
              'Could not load attempt history.',
            )}
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {pageState === 'empty' && (
        <p
          className="tactic-puzzles-history__status tactic-puzzles-history__status--empty"
          data-testid="tactic-puzzles-history-empty"
        >
          {t(
            'tacticPuzzle.history.empty',
            'No attempts yet. Solve one puzzle and it will appear here.',
          )}
        </p>
      )}

      {pageState === 'ready' && (
        <ul
          className="tactic-puzzles-history__list"
          data-testid="tactic-puzzles-history-list"
        >
          {attempts.map((a: TacticAttemptListItem) => {
            const orientation = sideFromFen(a.fen);
            const deltaSign = a.ratingDelta > 0 ? '+' : a.ratingDelta < 0 ? '−' : '';
            const deltaAbs = Math.abs(a.ratingDelta);
            const deltaArrow = a.ratingDelta > 0 ? '↑' : a.ratingDelta < 0 ? '↓' : '·';
            return (
              <li
                key={a.id}
                className="tactic-puzzles-history__card"
                data-testid="tactic-puzzles-history-card"
                data-attempt-id={a.id}
                data-solved={a.solved ? 'true' : 'false'}
                data-stop-reason={a.stopReason}
              >
                <Link
                  to={`/tactic-puzzles/attempts/${a.id}`}
                  className="tactic-puzzles-history__board"
                  aria-label={t('tacticPuzzle.history.openReview', 'Open review')}
                  data-testid="tactic-puzzles-history-card-board"
                >
                  <Chessboard
                    options={{
                      position: a.fen,
                      boardOrientation: orientation,
                      animationDurationInMs: 0,
                      allowDragging: false,
                      showNotation: false,
                    }}
                  />
                </Link>
                <div className="tactic-puzzles-history__body">
                  <div className="tactic-puzzles-history__row">
                    <span
                      className={`tactic-puzzles-history__outcome tactic-puzzles-history__outcome--${
                        a.solved ? 'solved' : 'failed'
                      }`}
                      data-testid="tactic-puzzles-history-card-outcome"
                    >
                      {a.solved
                        ? t('tacticPuzzle.history.outcome.solved', 'Solved')
                        : t('tacticPuzzle.history.outcome.failed', 'Failed')}
                    </span>
                    <span
                      className="tactic-puzzles-history__stop-reason"
                      data-testid="tactic-puzzles-history-card-stop"
                    >
                      {t(
                        `tacticPuzzle.history.stopReason.${a.stopReason}`,
                        a.stopReason,
                      )}
                    </span>
                  </div>
                  <div className="tactic-puzzles-history__players">
                    {a.playersTitle ??
                      t(
                        'tacticPuzzle.history.playersFallback',
                        'No source game',
                      )}
                  </div>
                  <div className="tactic-puzzles-history__meta">
                    <span>
                      {t('tacticPuzzle.history.labels.lineLength', 'Moves')}:{' '}
                      {a.lineHalfMoves}
                    </span>
                    <span>
                      {t('tacticPuzzle.history.labels.duration', 'Time')}:{' '}
                      {formatDuration(a.timeMs)}
                    </span>
                    <span>
                      {t('tacticPuzzle.history.labels.rating', 'Rating')}:{' '}
                      {a.ratingBefore} → {a.ratingAfter}
                    </span>
                    <span
                      className={`tactic-puzzles-history__delta tactic-puzzles-history__delta--${
                        a.ratingDelta > 0
                          ? 'up'
                          : a.ratingDelta < 0
                            ? 'down'
                            : 'flat'
                      }`}
                      data-testid="tactic-puzzles-history-card-delta"
                    >
                      {deltaArrow} {deltaSign}
                      {deltaAbs}
                    </span>
                  </div>
                  <div className="tactic-puzzles-history__footer">
                    <time
                      className="tactic-puzzles-history__time"
                      dateTime={a.createdAt}
                    >
                      {formatPlayedAt(a.createdAt, i18n.language)}
                    </time>
                    <Link
                      to={`/tactic-puzzles/attempts/${a.id}`}
                      className="tactic-puzzles-history__open-review"
                      data-testid="tactic-puzzles-history-card-open"
                    >
                      {t('tacticPuzzle.history.openReview', 'Open review')} →
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pageState === 'ready' && hasMore && (
        <div
          ref={setSentinelEl}
          data-testid="tactic-puzzles-history-load-more-sentinel"
          aria-hidden="true"
          style={{ height: 1 }}
        />
      )}
      {loadingMore && (
        <p
          className="tactic-puzzles-history__status"
          data-testid="tactic-puzzles-history-load-more"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}
    </div>
  );
}
