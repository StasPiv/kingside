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

// KS-4606. Сохранение последнего выбранного фильтра «решал/не решал».
// При возвращении в каталог без URL-параметра восстанавливаем последний
// выбор пользователя. Дефолт для новых пользователей (нет записи в
// localStorage и нет URL-параметра) — `unsolved` («Не решал»).
//
// Прежний ключ `kingside:critical-moment:visited` (KS-4491,
// одноразовый флаг «уже заходил») заменён этим — он не сохранял выбор
// после первого визита: ушёл с фильтром «Не решал», вернулся —
// сбрасывалось на «Все».
const LAST_FILTER_LS_KEY = 'kingside:critical-moment:lastSolvedFilter';
type SolvedFilter = 'all' | 'unsolved' | 'solved';

function readSavedFilter(): SolvedFilter | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(LAST_FILTER_LS_KEY);
    if (v === 'all' || v === 'unsolved' || v === 'solved') return v;
  } catch {
    /* localStorage недоступен (Safari private + ITP) */
  }
  return null;
}

function writeSavedFilter(v: SolvedFilter): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_FILTER_LS_KEY, v);
  } catch {
    /* см. catch выше */
  }
}

export function TacticPuzzlesPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // KS-4366 / KS-4606: фильтр по «решал/не решал». Гостю backend
  // параметр игнорирует — поэтому переключатель показываем только
  // авторизованным. URL-параметр — источник истины внутри страницы.
  const solvedParam = searchParams.get('solved');
  const solvedFilter: SolvedFilter =
    solvedParam === 'true'
      ? 'solved'
      : solvedParam === 'false'
        ? 'unsolved'
        : 'all';

  // KS-4606. При заходе авторизованного пользователя без URL-параметра
  // подставляем сохранённый ранее выбор из localStorage. Если выбора
  // нет (новый пользователь, чистый incognito) — дефолт `unsolved`
  // («Не решал»). Это решает жалобу «фильтр не сохраняется»: ушёл с
  // выбором «Не решал», вернулся — каталог снова показывает «Не решал».
  // Прежняя логика KS-4491 ставила дефолт ТОЛЬКО на первом заходе,
  // далее без URL → `all`.
  //
  // Гостю никакого auto-redirect не делаем: backend параметр игнорирует,
  // переключатель скрыт.
  useEffect(() => {
    if (!user) return;
    if (solvedParam !== null) return;
    const saved = readSavedFilter() ?? 'unsolved';
    const sp = new URLSearchParams(searchParams);
    if (saved === 'all') return; // URL пустой = `all`, дополнительно ничего не пишем
    sp.set('solved', saved === 'solved' ? 'true' : 'false');
    setSearchParams(sp, { replace: true });
  }, [user, solvedParam, searchParams, setSearchParams]);

  const filters = useMemo<TacticPuzzleBrowseQuery>(
    () => ({
      solved:
        !user || solvedFilter === 'all'
          ? undefined
          : solvedFilter === 'solved',
      limit: LIMIT,
    }),
    [solvedFilter, user],
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
        navigate(`/critical-moment/${next.id}`);
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
      <PageSeo ns="tacticPuzzles.list" path="/critical-moment" />
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

        {/* KS-4366: фильтр-сегмент по «решал/не решал». Гостю backend
            параметр игнорирует, поэтому переключатель скрыт.
            KS-4491: модификатор `--tactic-puzzles` нужен, чтобы
            переопределить mobile-hide из media-query `.precision-
            objective-segments { display: none }` (он завязан на
            chips-bar у /precision; на /critical-moment chips-bar нет,
            фильтр должен оставаться видимым на мобильном). */}
        {user && (
          <nav
            className="precision-objective-segments precision-objective-segments--tactic-puzzles"
            data-testid="tactic-puzzles-solved-segments"
            aria-label={t('tacticPuzzle.solvedFilter.label')}
            role="tablist"
          >
            {(['all', 'unsolved', 'solved'] as const).map((key) => {
              const active = solvedFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`precision-objective-segment${
                    active ? ' precision-objective-segment--active' : ''
                  }`}
                  data-testid={`tactic-puzzles-solved-${key}`}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => {
                    const sp = new URLSearchParams(searchParams);
                    if (key === 'all') sp.delete('solved');
                    else sp.set('solved', key === 'solved' ? 'true' : 'false');
                    setSearchParams(sp, { replace: false });
                    // KS-4606: запоминаем выбор пользователя, чтобы
                    // при возвращении в каталог без URL-параметра
                    // восстановить тот же фильтр.
                    writeSavedFilter(key);
                  }}
                >
                  {t(`tacticPuzzle.solvedFilter.${key}`)}
                </button>
              );
            })}
          </nav>
        )}
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
            const puzzleUrl = `/critical-moment/${p.id}`;
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
                  </div>
                  <div
                    className="play-vs-engine-card__stats"
                    data-testid="tactic-puzzles-card-stats"
                  >
                    <span>
                      {t('tacticPuzzle.difficulty')}:{' '}
                      {(p.difficulty * 100).toFixed(0)}%
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
