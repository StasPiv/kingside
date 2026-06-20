/**
 * KS-4362 / ADR-136 T10. Страница `/critical-moment/mistakes` — журнал
 * нерешённых ошибок текущего пользователя.
 *
 * Источник данных:
 *   - `GET /critical-moment/mistakes` — пагинированный список
 *     `TacticMistakeListItem`;
 *   - `POST /critical-moment/mistakes/:puzzleId/resolve` — ручной
 *     резолв (после успешного решения backend резолвит сам).
 *
 * Раскладка:
 *   1. `<TacticPuzzlesSubNav />` сверху (активный пункт «Ошибки»).
 *   2. Заголовок + intro.
 *   3. Сетка карточек: мини-доска (FEN), имена/событие из
 *      `playersTitle`, причина последней попытки (`lastStopReason`),
 *      сложность %, дата добавления; действия «Перерешать»/«Снять».
 *   4. Пустое состояние — приглашение к тренировке.
 *
 * Гостю — приглашение войти. PageSeo noindex.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import type { TacticMistakeListItem } from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { PageSeo } from '../components/seo/PageSeo';
import { TacticPuzzlesSubNav } from '../components/tactic-puzzles/TacticPuzzlesSubNav';
import { useInfiniteTacticMistakes } from '../hooks/useInfiniteTacticMistakes';
import { tacticPuzzleApi } from '../api/api-tactic-puzzle';

const LIMIT = 30;

function sideFromFen(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

function formatAddedAt(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function TacticPuzzlesMistakesPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  const {
    mistakes,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    removeLocally,
    patchLocally,
  } = useInfiniteTacticMistakes(LIMIT);

  // ── Resolve (optimistic) ────────────────────────────────────────
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const handleResolve = useCallback(
    async (item: TacticMistakeListItem) => {
      if (resolvingId === item.puzzleId) return;
      setResolvingId(item.puzzleId);
      setResolveError(null);
      // Optimistic: помечаем «resolved=true», скрываем визуально.
      // Если запрос упал — возвращаем флаг.
      patchLocally(item.puzzleId, { resolved: true });
      try {
        await tacticPuzzleApi.resolveMistake(item.puzzleId);
        removeLocally(item.puzzleId);
      } catch {
        patchLocally(item.puzzleId, { resolved: false });
        setResolveError(
          t(
            'tacticPuzzle.mistakes.resolveError',
            'Could not remove puzzle from the list.',
          ),
        );
      } finally {
        setResolvingId(null);
      }
    },
    [resolvingId, patchLocally, removeLocally, t],
  );

  const handleReplay = useCallback(
    (item: TacticMistakeListItem) => {
      navigate(`/critical-moment/${item.puzzleId}`);
    },
    [navigate],
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
  }, [loading, loadingMore, hasMore, mistakes.length]);

  const isGuest = !user;
  const pageState: 'guest' | 'loading' | 'error' | 'empty' | 'ready' = isGuest
    ? 'guest'
    : loading
      ? 'loading'
      : error
        ? 'error'
        : mistakes.length === 0
          ? 'empty'
          : 'ready';

  return (
    <div
      className="tactic-puzzles-mistakes"
      data-testid="tactic-puzzles-mistakes"
      data-auth={isGuest ? 'guest' : 'user'}
      data-state={pageState}
    >
      <PageSeo
        ns="tacticPuzzles.mistakes"
        path="/critical-moment/mistakes"
        noindex
      />
      <TacticPuzzlesSubNav />

      <header className="tactic-puzzles-mistakes__header">
        <h1>{t('tacticPuzzle.mistakes.title', 'Mistake review')}</h1>
        <p className="tactic-puzzles-mistakes__intro">
          {t(
            'tacticPuzzle.mistakes.intro',
            'Puzzles you failed and have not closed yet. Solve them again and they will drop from the list automatically.',
          )}
        </p>
      </header>

      {resolveError && (
        <p
          className="tactic-puzzles-mistakes__status tactic-puzzles-mistakes__status--error"
          data-testid="tactic-puzzles-mistakes-resolve-error"
          role="alert"
        >
          {resolveError}
        </p>
      )}

      {pageState === 'guest' && (
        <section
          className="tactic-puzzles-mistakes__guest"
          data-testid="tactic-puzzles-mistakes-guest"
        >
          <h2>
            {t(
              'tacticPuzzle.mistakes.guestTitle',
              'Sign in to see your mistakes',
            )}
          </h2>
          <p>
            {t(
              'tacticPuzzle.mistakes.guestMessage',
              'The mistakes journal is available to signed-in players only.',
            )}
          </p>
          <Link to="/login" className="tactic-puzzles-mistakes__guest-cta">
            {t('precision.history.guest.cta', 'Sign in')}
          </Link>
        </section>
      )}

      {pageState === 'loading' && (
        <p
          className="tactic-puzzles-mistakes__status"
          data-testid="tactic-puzzles-mistakes-loading"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}

      {pageState === 'error' && (
        <div
          className="tactic-puzzles-mistakes__status tactic-puzzles-mistakes__status--error"
          data-testid="tactic-puzzles-mistakes-error"
        >
          <p>
            {t(
              'tacticPuzzle.mistakes.loadError',
              'Could not load mistakes.',
            )}
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {pageState === 'empty' && (
        <p
          className="tactic-puzzles-mistakes__status tactic-puzzles-mistakes__status--empty"
          data-testid="tactic-puzzles-mistakes-empty"
        >
          {t(
            'tacticPuzzle.mistakes.empty',
            'Your mistakes journal is empty. Keep practicing and revisit failed puzzles here.',
          )}
        </p>
      )}

      {pageState === 'ready' && (
        <ul
          className="tactic-puzzles-mistakes__list"
          data-testid="tactic-puzzles-mistakes-list"
        >
          {mistakes.map((m: TacticMistakeListItem) => {
            const orientation = sideFromFen(m.fen);
            const resolving = resolvingId === m.puzzleId;
            return (
              <li
                key={m.puzzleId}
                className="tactic-puzzles-mistakes__card"
                data-testid="tactic-puzzles-mistakes-card"
                data-puzzle-id={m.puzzleId}
                data-resolved={m.resolved ? 'true' : 'false'}
              >
                <Link
                  to={`/critical-moment/${m.puzzleId}`}
                  className="tactic-puzzles-mistakes__board"
                  data-testid="tactic-puzzles-mistakes-card-board"
                  aria-label={t('tacticPuzzle.openPuzzle', 'Open puzzle')}
                >
                  <Chessboard
                    options={{
                      position: m.fen,
                      boardOrientation: orientation,
                      animationDurationInMs: 0,
                      allowDragging: false,
                      showNotation: false,
                    }}
                  />
                </Link>
                <div className="tactic-puzzles-mistakes__body">
                  <div
                    className="tactic-puzzles-mistakes__players"
                    data-testid="tactic-puzzles-mistakes-card-players"
                  >
                    {m.playersTitle ??
                      t(
                        'tacticPuzzle.mistakes.playersFallback',
                        'No source game',
                      )}
                  </div>
                  <div className="tactic-puzzles-mistakes__meta">
                    <span>
                      {t(
                        'tacticPuzzle.mistakes.labels.difficulty',
                        'Difficulty',
                      )}
                      : {(m.difficulty * 100).toFixed(0)}%
                    </span>
                  </div>
                  {m.lastStopReason && (
                    <div
                      className="tactic-puzzles-mistakes__last-reason"
                      data-testid="tactic-puzzles-mistakes-card-last-reason"
                    >
                      {t(
                        'tacticPuzzle.mistakes.labels.lastStopReason',
                        'Last attempt',
                      )}
                      :{' '}
                      <span
                        className="tactic-puzzles-mistakes__stop-reason"
                        data-stop-reason={m.lastStopReason}
                      >
                        {t(
                          `tacticPuzzle.history.stopReason.${m.lastStopReason}`,
                          m.lastStopReason,
                        )}
                      </span>
                    </div>
                  )}
                  <div className="tactic-puzzles-mistakes__footer">
                    <time
                      className="tactic-puzzles-mistakes__added"
                      dateTime={m.createdAt}
                    >
                      {t('tacticPuzzle.mistakes.labels.addedAt', 'Added')}
                      :{' '}
                      {formatAddedAt(m.createdAt, i18n.language)}
                    </time>
                    <div className="tactic-puzzles-mistakes__actions">
                      <button
                        type="button"
                        className="play-btn play-btn--compact"
                        onClick={() => handleReplay(m)}
                        data-testid="tactic-puzzles-mistakes-card-replay"
                      >
                        {t('tacticPuzzle.mistakes.actions.replay', 'Replay')}
                      </button>
                      <button
                        type="button"
                        className="play-btn play-btn--secondary play-btn--compact"
                        onClick={() => void handleResolve(m)}
                        disabled={resolving}
                        data-testid="tactic-puzzles-mistakes-card-resolve"
                      >
                        {resolving
                          ? t(
                              'tacticPuzzle.mistakes.actions.resolving',
                              'Removing…',
                            )
                          : t(
                              'tacticPuzzle.mistakes.actions.resolve',
                              'Remove',
                            )}
                      </button>
                    </div>
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
          data-testid="tactic-puzzles-mistakes-load-more-sentinel"
          aria-hidden="true"
          style={{ height: 1 }}
        />
      )}
      {loadingMore && (
        <p
          className="tactic-puzzles-mistakes__status"
          data-testid="tactic-puzzles-mistakes-load-more"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}
    </div>
  );
}
