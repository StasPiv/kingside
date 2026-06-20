/**
 * KS-4343 → KS-4344 / ADR-135 §2.5. Каталог раздела «Точность».
 *
 * Вёрстка переиспользует существующие CSS-классы `play-vs-engine-*` /
 * `precision-objective-segment*` (см. `puzzle.css`) — единый стиль с
 * `/precision`: сетка карточек с миниатюрой доски, метаданными
 * (игроки/ELO/событие/сложность/рейтинг) и кнопкой «Решить».
 *
 * Локализация: все строки через i18next (`tacticPuzzle.*`). Ссылка
 * на старый `/precision` скрыта до cleanup'а T9/T10 — пользователю не
 * нужно знать о parallel-разделе.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import type {
  TacticPuzzleBrowseQuery,
  TacticPuzzleObjective,
  TacticPuzzleResponse,
} from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { PageSeo } from '../components/seo/PageSeo';
import { useInfiniteTacticPuzzles } from '../hooks/useInfiniteTacticPuzzles';
import { tacticPuzzleApi } from '../api/api-tactic-puzzle';
import { TacticPuzzlesSubNav } from '../components/tactic-puzzles/TacticPuzzlesSubNav';

const LIMIT = 20;

function sideFromFen(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

/**
 * Читает год из PGN-тега `Date` (формат `YYYY.MM.DD` или `YYYY`). Возвращает
 * пустую строку, если поле не парсится.
 */
function extractYear(date: string | undefined | null): string {
  if (!date) return '';
  const m = /^(\d{4})/.exec(date);
  return m ? m[1] : '';
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

  const filters = useMemo<TacticPuzzleBrowseQuery>(
    () => ({
      objective: objective === 'all' ? undefined : objective,
      limit: LIMIT,
    }),
    [objective],
  );

  const { puzzles, loading, loadingMore, error, hasMore, loadMore } =
    useInfiniteTacticPuzzles(filters);

  // ── Auto-pick кнопка «Начать тренировку» ─────────────────────────
  const [startingTraining, setStartingTraining] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const handleStartTraining = useCallback(async () => {
    if (startingTraining) return;
    if (!user) {
      // /next требует JWT — гостя ведём в обычный каталог, авто-подбор
      // ему недоступен.
      setStartError(t('tacticPuzzle.startError.guest'));
      return;
    }
    setStartingTraining(true);
    setStartError(null);
    try {
      const next = await tacticPuzzleApi.pickNext();
      if (next) {
        navigate(`/tactic-puzzles/${next.id}`);
      } else {
        setStartError(t('tacticPuzzle.startError.noPuzzles'));
      }
    } catch {
      setStartError(t('tacticPuzzle.startError.generic'));
    } finally {
      setStartingTraining(false);
    }
  }, [startingTraining, user, navigate, t]);

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
      className="play-vs-engine-puzzles"
      data-testid="tactic-puzzles"
      data-state={pageState}
    >
      <PageSeo ns="tacticPuzzles.list" path="/tactic-puzzles" />
      <TacticPuzzlesSubNav />
      <header className="play-vs-engine-puzzles__header">
        <h1>{t('tacticPuzzle.title')}</h1>
        <p className="play-vs-engine-puzzles__intro">
          {t('tacticPuzzle.intro')}
        </p>

        <div className="play-vs-engine-puzzles__nav">
          <button
            type="button"
            className="generate-puzzles-btn"
            data-testid="tactic-puzzles-start"
            onClick={() => void handleStartTraining()}
            disabled={startingTraining}
          >
            {startingTraining
              ? t('tacticPuzzle.starting')
              : t('tacticPuzzle.start')}
          </button>
        </div>
        {startError && (
          <p
            className="play-vs-engine-puzzles__status play-vs-engine-puzzles__status--error"
            data-testid="tactic-puzzles-start-error"
          >
            {startError}
          </p>
        )}

        <nav
          className="precision-objective-segments"
          data-testid="tactic-puzzles-objective-segments"
          aria-label={t('tacticPuzzle.objective.label')}
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
                className={`precision-objective-segment${
                  active ? ' precision-objective-segment--active' : ''
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
                  ? t('tacticPuzzle.objective.all')
                  : key === 'convertAdvantage'
                    ? t('puzzle.objective.convertAdvantage')
                    : t('puzzle.objective.saveEquality')}
              </button>
            );
          })}
        </nav>
      </header>

      {pageState === 'loading' && (
        <p
          className="play-vs-engine-puzzles__status"
          data-testid="tactic-puzzles-loading"
        >
          {t('common.loading')}
        </p>
      )}

      {pageState === 'error' && (
        <div
          className="play-vs-engine-puzzles__status play-vs-engine-puzzles__status--error"
          data-testid="tactic-puzzles-error"
        >
          <p>{t('tacticPuzzle.loadError')}</p>
          <button type="button" onClick={() => window.location.reload()}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {pageState === 'empty' && (
        <p
          className="play-vs-engine-puzzles__status play-vs-engine-puzzles__status--empty"
          data-testid="tactic-puzzles-empty"
        >
          {t('tacticPuzzle.gridEmpty')}
        </p>
      )}

      {pageState === 'ready' && (
        <div
          className="play-vs-engine-puzzles__list"
          data-testid="tactic-puzzles-list"
        >
          {puzzles.map((p: TacticPuzzleResponse) => {
            const orientation = sideFromFen(p.fen);
            const puzzleUrl = `/tactic-puzzles/${p.id}`;
            const headers = p.sourceHeaders ?? null;
            const whiteName = headers?.White ?? null;
            const blackName = headers?.Black ?? null;
            const whiteElo = headers?.WhiteElo ?? null;
            const blackElo = headers?.BlackElo ?? null;
            const event = headers?.Event ?? null;
            const year = extractYear(headers?.Date);
            const eventLabel = event
              ? year && !event.includes(year)
                ? `${event} · ${year}`
                : event
              : null;
            const whiteLabel = whiteName
              ? whiteElo
                ? `${whiteName} (${whiteElo})`
                : whiteName
              : null;
            const blackLabel = blackName
              ? blackElo
                ? `${blackName} (${blackElo})`
                : blackName
              : null;
            const hasPlayers = whiteLabel || blackLabel;
            return (
              <article
                key={p.id}
                className="play-vs-engine-card"
                data-testid="tactic-puzzles-card"
                data-puzzle-id={p.id}
              >
                <Link
                  to={puzzleUrl}
                  className="play-vs-engine-card__board-btn"
                  aria-label={t('tacticPuzzle.openPuzzle')}
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
                <div className="play-vs-engine-card__body">
                  <div
                    className="play-vs-engine-card__meta"
                    data-testid="tactic-puzzles-card-meta"
                  >
                    <span
                      className="play-vs-engine-card__side"
                      data-side={orientation}
                    >
                      {orientation === 'white'
                        ? t('drills.side.whiteToMove')
                        : t('drills.side.blackToMove')}
                    </span>
                    <span
                      className="play-vs-engine-card__objective"
                      data-objective={p.objective}
                    >
                      {p.objective === 'convertAdvantage'
                        ? t('puzzle.objective.convertAdvantage')
                        : t('puzzle.objective.saveEquality')}
                    </span>
                  </div>
                  <div
                    className="play-vs-engine-card__stats"
                    data-testid="tactic-puzzles-card-stats"
                  >
                    <span>
                      {t('tacticPuzzle.difficulty')}:{' '}
                      {(p.difficulty * 100).toFixed(0)}%
                    </span>
                    <span>
                      {t('tacticPuzzle.rating')}: {p.rating}
                    </span>
                  </div>
                  {hasPlayers && (
                    <div
                      className="play-vs-engine-card__source"
                      data-testid="tactic-puzzles-card-source"
                    >
                      <div className="play-vs-engine-card__source-players">
                        {[whiteLabel, blackLabel].filter(Boolean).join(' — ')}
                        {eventLabel ? ` · ${eventLabel}` : ''}
                      </div>
                    </div>
                  )}
                  <Link
                    to={puzzleUrl}
                    className="play-vs-engine-card__solve-btn"
                    data-testid="tactic-puzzles-card-solve"
                  >
                    {t('tacticPuzzle.solve')}
                  </Link>
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
          className="play-vs-engine-puzzles__status"
          data-testid="tactic-puzzles-load-more"
        >
          {t('common.loading')}
        </p>
      )}
    </div>
  );
}
