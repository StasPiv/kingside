/**
 * KS-4343 / ADR-135 §2.5. Каталог раздела «Точность» на новой
 * таблице `tactic_puzzles`. Маршрут `/tactic-puzzles/*`.
 *
 * MVP-разрез T6: список + 3 сегментных фильтра (`objective`/scope/themes
 * сводим к минимуму), сценарии auth/guest, переход на solve-страницу
 * `/tactic-puzzles/:id`. Полный набор фильтров (Maia-сложность range,
 * темы bottom-sheet, scope drafts/published, статистика) переезжает из
 * `PrecisionPage` отдельной задачей в рамках cleanup'а T9/T10 — здесь
 * страница строится с нуля по новому API, чтобы:
 *   - не тянуть `useInfinitePuzzles`/`/precision/*` контракт;
 *   - чисто проверить контракт `/tactic-puzzles/*` (KS-4342) на живых
 *     данных, не пересекаясь со старым flow.
 *
 * Старая `PrecisionPage` остаётся на `/precision` — её удалит T9/T10.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import { useAuth } from '../context/AuthContext';
import { PageSeo } from '../components/seo/PageSeo';
import {
  useInfiniteTacticPuzzles,
} from '../hooks/useInfiniteTacticPuzzles';
import type {
  BrowseTacticPuzzleDto,
  TacticBrowseFilters,
  TacticPuzzleObjective,
} from '../api/api-tactic-puzzle';
import { tacticPuzzleApi } from '../api/api-tactic-puzzle';

const LIMIT = 20;

function sideFromFen(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

export function TacticPuzzlesPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const objectiveParam = searchParams.get('objective');
  const objective: TacticPuzzleObjective | 'all' =
    objectiveParam === 'convertAdvantage' || objectiveParam === 'saveEquality'
      ? objectiveParam
      : 'all';
  const showSolvedParam = searchParams.get('showSolved') === 'true';
  const hideSolved = !showSolvedParam;

  const filters = useMemo<TacticBrowseFilters>(
    () => ({
      objective,
      hideSolved: user ? hideSolved : undefined,
      limit: LIMIT,
    }),
    [objective, hideSolved, user],
  );

  const { puzzles, loading, loadingMore, error, hasMore, loadMore } =
    useInfiniteTacticPuzzles(filters);

  // ── Auto-pick кнопка «Начать тренировку» ─────────────────────────
  const [startingTraining, setStartingTraining] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const handleStartTraining = useCallback(async () => {
    if (startingTraining) return;
    setStartingTraining(true);
    setStartError(null);
    try {
      const res = await tacticPuzzleApi.pickNext({
        objective: objective === 'all' ? undefined : objective,
        hideSolved: user ? true : undefined,
      });
      if (res.puzzle) {
        navigate(`/tactic-puzzles/${res.puzzle.id}`);
      } else {
        setStartError(
          t(
            'tacticPuzzle.startError.noPuzzles',
            'No puzzles available for current filters.',
          ),
        );
      }
    } catch {
      setStartError(
        t('tacticPuzzle.startError.generic', 'Could not pick a puzzle.'),
      );
    } finally {
      setStartingTraining(false);
    }
  }, [startingTraining, objective, user, navigate, t]);

  // ── IntersectionObserver-infinite scroll ─────────────────────────
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
      { rootMargin: '600px' },
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
  }, [loading, loadingMore, hasMore, puzzles.length]);

  const pageState: 'loading' | 'ready' | 'empty' | 'error' = loading
    ? 'loading'
    : error
      ? 'error'
      : puzzles.length === 0
        ? 'empty'
        : 'ready';

  return (
    <div
      className="tactic-puzzles"
      data-testid="tactic-puzzles"
      data-state={pageState}
    >
      <PageSeo ns="tacticPuzzle.list" path="/tactic-puzzles" />
      <header className="tactic-puzzles__header">
        <h1>{t('tacticPuzzle.title', 'Tactic puzzles')}</h1>
        <p className="tactic-puzzles__intro">
          {t(
            'tacticPuzzle.intro',
            'Single-move tactics where a top engine punishes the wrong choice. The puzzle continues as long as the position stays sharp.',
          )}
        </p>

        <div className="tactic-puzzles__nav">
          <Link to="/precision" className="tactic-puzzles__legacy-link">
            ← {t('tacticPuzzle.backToLegacy', 'Legacy precision')}
          </Link>
          <button
            type="button"
            className="tactic-puzzles__start-btn"
            data-testid="tactic-puzzles-start"
            onClick={() => void handleStartTraining()}
            disabled={startingTraining}
          >
            {startingTraining
              ? t('tacticPuzzle.starting', 'Starting…')
              : t('tacticPuzzle.start', 'Start training')}
          </button>
        </div>
        {startError && (
          <p
            className="tactic-puzzles__start-error"
            data-testid="tactic-puzzles-start-error"
          >
            {startError}
          </p>
        )}

        <nav
          className="tactic-puzzles__objective-segments"
          data-testid="tactic-puzzles-objective-segments"
          aria-label={t('tacticPuzzle.objective.label', 'Puzzle type')}
          role="tablist"
        >
          {(['all', 'convertAdvantage', 'saveEquality'] as const).map((key) => {
            const active = objective === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                className={`tactic-puzzles__objective-segment${
                  active ? ' tactic-puzzles__objective-segment--active' : ''
                }`}
                data-testid={`tactic-puzzles-objective-${key}`}
                data-active={active ? 'true' : 'false'}
                onClick={() => {
                  const sp = new URLSearchParams(searchParams);
                  if (key === 'all') sp.delete('objective');
                  else sp.set('objective', key);
                  setSearchParams(sp, { replace: false });
                }}
              >
                {key === 'all'
                  ? t('tacticPuzzle.objective.all', 'All')
                  : key === 'convertAdvantage'
                    ? t(
                        'puzzle.objective.convertAdvantage',
                        'Convert the advantage',
                      )
                    : t('puzzle.objective.saveEquality', 'Save the draw')}
              </button>
            );
          })}
        </nav>

        {user && (
          <label
            className="tactic-puzzles__show-solved"
            data-testid="tactic-puzzles-show-solved"
          >
            <input
              type="checkbox"
              checked={showSolvedParam}
              onChange={(e) => {
                const sp = new URLSearchParams(searchParams);
                if (e.target.checked) sp.set('showSolved', 'true');
                else sp.delete('showSolved');
                setSearchParams(sp, { replace: false });
              }}
              data-testid="tactic-puzzles-show-solved-input"
            />
            {t('tacticPuzzle.showSolved', 'Show solved')}
          </label>
        )}
      </header>

      {pageState === 'loading' && (
        <p
          className="tactic-puzzles__status"
          data-testid="tactic-puzzles-loading"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}

      {pageState === 'error' && (
        <div
          className="tactic-puzzles__status tactic-puzzles__status--error"
          data-testid="tactic-puzzles-error"
        >
          <p>{t('tacticPuzzle.loadError', 'Could not load puzzles.')}</p>
          <button type="button" onClick={() => window.location.reload()}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {pageState === 'empty' && (
        <p
          className="tactic-puzzles__status tactic-puzzles__status--empty"
          data-testid="tactic-puzzles-empty"
        >
          {t(
            'tacticPuzzle.gridEmpty',
            'No puzzles in this slice yet — generator is still filling the bank.',
          )}
        </p>
      )}

      {pageState === 'ready' && (
        <div
          className="tactic-puzzles__list"
          data-testid="tactic-puzzles-list"
        >
          {puzzles.map((p: BrowseTacticPuzzleDto) => {
            const orientation = sideFromFen(p.fen);
            const puzzleUrl = `/tactic-puzzles/${p.id}`;
            return (
              <article
                key={p.id}
                className="tactic-puzzles__card"
                data-testid="tactic-puzzles-card"
                data-puzzle-id={p.id}
                data-solved={p.solvedStatus ?? 'none'}
              >
                <Link
                  to={puzzleUrl}
                  className="tactic-puzzles__card-board"
                  aria-label={t('tacticPuzzle.openPuzzle', 'Open puzzle')}
                  data-testid="tactic-puzzles-card-board"
                >
                  <Chessboard
                    options={{
                      position: p.fen,
                      boardOrientation: orientation,
                      animationDurationInMs: 0,
                      allowDragging: false,
                      showNotation: false,
                    }}
                  />
                </Link>
                <div className="tactic-puzzles__card-body">
                  <div
                    className="tactic-puzzles__card-meta"
                    data-testid="tactic-puzzles-card-meta"
                  >
                    <span
                      className="tactic-puzzles__card-side"
                      data-side={orientation}
                    >
                      {orientation === 'white'
                        ? t('drills.side.whiteToMove', 'White to move')
                        : t('drills.side.blackToMove', 'Black to move')}
                    </span>
                    <span
                      className="tactic-puzzles__card-objective"
                      data-objective={p.objective}
                    >
                      {p.objective === 'convertAdvantage'
                        ? t(
                            'puzzle.objective.convertAdvantage',
                            'Convert the advantage',
                          )
                        : t('puzzle.objective.saveEquality', 'Save the draw')}
                    </span>
                    <span className="tactic-puzzles__card-difficulty">
                      {t('tacticPuzzle.difficulty', 'Difficulty')}:{' '}
                      {(p.difficulty * 100).toFixed(0)}%
                    </span>
                    <span className="tactic-puzzles__card-rating">
                      {t('tacticPuzzle.rating', 'Rating')}: {p.rating}
                    </span>
                  </div>
                  {p.sourceGame?.headers ? (
                    <div
                      className="tactic-puzzles__card-source"
                      data-testid="tactic-puzzles-card-source"
                    >
                      {p.sourceGame.headers.White ?? '?'}{' '}
                      {p.sourceGame.whiteElo
                        ? `(${p.sourceGame.whiteElo})`
                        : ''}{' '}
                      —{' '}
                      {p.sourceGame.headers.Black ?? '?'}{' '}
                      {p.sourceGame.blackElo
                        ? `(${p.sourceGame.blackElo})`
                        : ''}
                      {p.sourceGame.headers.Event
                        ? ` · ${p.sourceGame.headers.Event}`
                        : ''}
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {pageState === 'ready' && hasMore && (
        <div
          ref={setSentinelEl}
          data-testid="tactic-puzzles-load-more-sentinel"
          aria-hidden="true"
          style={{ height: 1 }}
        />
      )}
      {loadingMore && (
        <p
          className="tactic-puzzles__status"
          data-testid="tactic-puzzles-load-more"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}
    </div>
  );
}
