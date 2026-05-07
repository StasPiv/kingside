import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import type { PuzzleStatsByMode } from '@kingside/shared';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import {
  useInfinitePuzzles,
  type BrowsePuzzleDto,
  type InfinitePuzzleFilters,
} from '../hooks/useInfinitePuzzles';

/**
 * KS-2484 (ADR-044) → KS-2578 → KS-2585/KS-2586 — список тренировки
 * точности.
 *
 * Эволюция:
 *  - KS-2484: legacy `/puzzles?solutionMode=play-vs-engine` фильтр.
 *  - KS-2578: переезд на унифицированный `/puzzles/browse?source=
 *    generated`. Pages cards = generated пазлы (forced-line +
 *    play-vs-engine), lichess живёт в `/puzzles`.
 *  - KS-2585: добавил draft/publish-flow в PuzzleGeneratorModal.
 *  - KS-2586: индивидуальный publish из карточки на `/precision?mine=
 *    true`. URL-параметры:
 *      - `mine=true` — только пазлы текущего юзера;
 *      - `visibility=draft|public|all` — фильтр по `is_public`.
 *
 * Backend: `KS-2560` (source-фильтр), `KS-2580` (per-puzzle
 * `PATCH /puzzles/:id { isPublic }`), `KS-2582` (visibility-фильтр в
 * `/puzzles/browse`).
 *
 * # DOM
 *
 *   <div class="play-vs-engine-puzzles" data-testid="play-vs-engine-puzzles"
 *        data-state="loading|ready|empty|error" data-mine="true|false"
 *        data-visibility="draft|public|all">
 *     <article data-testid="play-vs-engine-card" data-puzzle-id="…"
 *              data-public="true|false">
 *       …
 *       <span data-testid="precision-card-draft-badge" />     // если draft+owned
 *       <button data-testid="precision-card-publish" />        // если draft+owned
 *     </article>
 *     …
 *   </div>
 */

const LIMIT = 20;

function sideFromFen(fen: string): 'white' | 'black' {
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'black' : 'white';
}

interface PrecisionStatsState {
  totalAttempted: number;
  totalSolved: number;
  lastAttemptAt: string | null;
}

interface PuzzleStatsMeResponse {
  byMode?: PuzzleStatsByMode;
}

interface AttemptListItem {
  createdAt: string;
  puzzle?: { solutionMode?: 'forced-line' | 'play-vs-engine' };
}

function isVisibility(v: string | null): v is 'draft' | 'public' | 'all' {
  return v === 'draft' || v === 'public' || v === 'all';
}

export function PrecisionPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();

  // KS-2586: URL-state read.
  const mineParam = searchParams.get('mine') === 'true';
  const visibilityParam = searchParams.get('visibility');
  const visibility: 'draft' | 'public' | 'all' | undefined = isVisibility(
    visibilityParam,
  )
    ? visibilityParam
    : undefined;

  // KS-2586: миграция с raw `api.get` на `useInfinitePuzzles` —
  // нужен `patchLocally` для оптимистичного апдейта после publish'а.
  // Поведение page state'а сохраняем тем же набором значений.
  const filters = useMemo<InfinitePuzzleFilters>(
    () => ({
      source: 'generated',
      mine: mineParam ? true : undefined,
      visibility,
      limit: LIMIT,
    }),
    [mineParam, visibility],
  );

  const {
    puzzles,
    loading,
    error,
    patchLocally,
  } = useInfinitePuzzles(filters);

  const [stats, setStats] = useState<PrecisionStatsState | null>(null);

  /** id пазла, который сейчас публикуется (для disable + spinner). */
  const [publishingId, setPublishingId] = useState<string | null>(null);
  /** id пазла, недавно опубликованного — для 2-сек «Published» badge. */
  const [recentlyPublishedId, setRecentlyPublishedId] = useState<string | null>(
    null,
  );
  const [publishError, setPublishError] = useState<string | null>(null);

  const handlePublish = useCallback(
    async (puzzleId: string) => {
      if (publishingId) return;
      setPublishingId(puzzleId);
      setPublishError(null);
      try {
        await api.patch(`/puzzles/${puzzleId}`, { isPublic: true });
        // Оптимистичный апдейт через hook'овский patchLocally —
        // карточка моментально перерисовывается без isPublic=false.
        patchLocally(puzzleId, { isPublic: true });
        setRecentlyPublishedId(puzzleId);
        // Через 2 секунды убираем «Published» индикатор.
        window.setTimeout(() => {
          setRecentlyPublishedId((prev) => (prev === puzzleId ? null : prev));
        }, 2000);
      } catch (e) {
        setPublishError(e instanceof Error ? e.message : 'Publish failed');
      } finally {
        setPublishingId(null);
      }
    },
    [publishingId, patchLocally],
  );

  // Stats — без изменений после KS-2545. Переезжать на хук смысла нет:
  // источник `/puzzles/stats/me` отдельный.
  const fetchStats = useCallback(async () => {
    if (!user) {
      setStats(null);
      return;
    }
    try {
      const [statsRes, attemptsRes] = await Promise.all([
        api.get<PuzzleStatsMeResponse>('/puzzles/stats/me').catch(() => null),
        api
          .get<AttemptListItem[]>('/puzzles/attempts?take=20&skip=0')
          .catch(() => [] as AttemptListItem[]),
      ]);
      const mode = statsRes?.byMode?.['play-vs-engine'];
      const attempts = Array.isArray(attemptsRes) ? attemptsRes : [];
      const lastPve =
        attempts.find(
          (a) => a.puzzle?.solutionMode === 'play-vs-engine',
        ) ?? null;
      setStats({
        totalAttempted: mode?.attempts ?? 0,
        totalSolved: mode?.solved ?? 0,
        lastAttemptAt: lastPve ? lastPve.createdAt : null,
      });
    } catch {
      setStats(null);
    }
  }, [user]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

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
      data-testid="play-vs-engine-puzzles"
      data-state={pageState}
      data-mine={mineParam ? 'true' : 'false'}
      data-visibility={visibility ?? 'all'}
    >
      <header className="play-vs-engine-puzzles__header">
        <h1>{t('precision.title', 'Precision training')}</h1>
        <p className="play-vs-engine-puzzles__intro">
          {t(
            'precision.intro',
            'Practice positions where a Stockfish-strong engine punishes mistakes. Find the precise sequence and outplay the machine.',
          )}
        </p>
        <div className="play-vs-engine-puzzles__nav">
          <Link to="/puzzles" className="play-vs-engine-puzzles__back-link">
            ← {t('precision.backToAll', 'All puzzles')}
          </Link>
        </div>
        {/* KS-2545 / ADR-048 §6: top-блок stats. Видим только
            аутентифицированному юзеру (gate `user`) — гостям API
            возвращает 401 и stats будет null. */}
        {user && stats && (
          <div
            className="precision-stats"
            data-testid="precision-stats"
            data-attempts={String(stats.totalAttempted)}
            data-solved={String(stats.totalSolved)}
          >
            <div
              className="precision-stats__cell"
              data-testid="precision-stats-attempted"
            >
              <div className="precision-stats__value">
                {stats.totalAttempted}
              </div>
              <div className="precision-stats__label">
                {t('precision.stats.totalAttempted', 'Attempts')}
              </div>
            </div>
            <div
              className="precision-stats__cell"
              data-testid="precision-stats-solved"
            >
              <div className="precision-stats__value">
                {stats.totalSolved}
              </div>
              <div className="precision-stats__label">
                {t('precision.stats.totalSolved', 'Solved')}
              </div>
            </div>
            <div
              className="precision-stats__cell"
              data-testid="precision-stats-last-attempt"
            >
              <div className="precision-stats__value">
                {stats.lastAttemptAt
                  ? new Date(stats.lastAttemptAt).toLocaleDateString()
                  : '—'}
              </div>
              <div className="precision-stats__label">
                {t('precision.stats.lastAttempt', 'Last attempt')}
              </div>
            </div>
          </div>
        )}
      </header>

      {pageState === 'loading' && (
        <p
          className="play-vs-engine-puzzles__status"
          data-testid="play-vs-engine-loading"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}

      {pageState === 'error' && (
        <div
          className="play-vs-engine-puzzles__status play-vs-engine-puzzles__status--error"
          data-testid="play-vs-engine-error"
        >
          <p>{t('precision.loadError', 'Could not load puzzles.')}</p>
          {/* KS-2586: после миграции на хук — повторная попытка через
              перезагрузку страницы; хук сам делает fetch при mount. */}
          <button type="button" onClick={() => window.location.reload()}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {pageState === 'empty' && (
        <p
          className="play-vs-engine-puzzles__status play-vs-engine-puzzles__status--empty"
          data-testid="play-vs-engine-empty"
        >
          {t(
            'precision.empty',
            'No play-vs-engine puzzles yet — the generator is still filling the bank. Check back soon.',
          )}
        </p>
      )}

      {publishError && (
        <p
          className="play-vs-engine-puzzles__status play-vs-engine-puzzles__status--error"
          data-testid="precision-publish-error"
        >
          {publishError}
        </p>
      )}

      {pageState === 'ready' && (
        <div className="play-vs-engine-puzzles__list">
          {puzzles.map((p: BrowsePuzzleDto) => {
            const orientation = sideFromFen(p.fen);
            const isMine =
              user !== null && p.userId !== undefined && p.userId === user.id;
            const isDraft = p.isPublic === false;
            const justPublished = recentlyPublishedId === p.id;
            const onClick = () =>
              // KS-2547 / ADR-048 §5: новый канон `?source=precision`.
              navigate(`/puzzle/${p.id}?source=precision`);
            return (
              <article
                key={p.id}
                className="play-vs-engine-card"
                data-testid="play-vs-engine-card"
                data-puzzle-id={p.id}
                data-public={p.isPublic === false ? 'false' : 'true'}
                data-mine={isMine ? 'true' : 'false'}
              >
                <button
                  type="button"
                  className="play-vs-engine-card__board-btn"
                  onClick={onClick}
                  aria-label={t('precision.openPuzzle', 'Open puzzle')}
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
                </button>
                <div className="play-vs-engine-card__body">
                  <div className="play-vs-engine-card__title">
                    {t('precision.cardTitle', '#{{id}}', {
                      id: p.id.slice(0, 8),
                    })}
                    {/* KS-2586: badge «Draft» рядом с заголовком — виден
                        пользователю-владельцу, чтобы он знал что пазл
                        пока приватный. После publish исчезает. */}
                    {isMine && isDraft && (
                      <span
                        className="precision-card__badge precision-card__badge--draft"
                        data-testid="precision-card-draft-badge"
                      >
                        {t('precision.draftBadge', 'Draft')}
                      </span>
                    )}
                    {isMine && justPublished && (
                      <span
                        className="precision-card__badge precision-card__badge--published"
                        data-testid="precision-card-published-toast"
                      >
                        {t('precision.publishedBadge', 'Published')}
                      </span>
                    )}
                  </div>
                  <div className="play-vs-engine-card__meta">
                    <span
                      className="play-vs-engine-card__rating"
                      data-testid="play-vs-engine-card-rating"
                    >
                      {t('puzzleBrowser.yourRating', 'Puzzle rating: {{rating}}', {
                        rating: p.rating,
                      })}
                    </span>
                    <span
                      className="play-vs-engine-card__side"
                      data-side={orientation}
                    >
                      {orientation === 'white'
                        ? t('drills.side.whiteToMove', 'White to move')
                        : t('drills.side.blackToMove', 'Black to move')}
                    </span>
                  </div>
                  <div className="play-vs-engine-card__actions">
                    <button
                      type="button"
                      className="play-vs-engine-card__solve-btn"
                      data-testid="play-vs-engine-card-solve"
                      onClick={onClick}
                    >
                      {t('puzzleBrowser.solve', 'Solve')}
                    </button>
                    {/* KS-2586: индивидуальный publish — только владельцу
                        + только для draft (`isPublic=false`). После клика
                        — оптимистичный апдейт через `patchLocally`,
                        кнопка исчезает (т.к. isPublic=true), на 2с
                        показывается «Published» badge. */}
                    {isMine && isDraft && (
                      <button
                        type="button"
                        className="precision-card__publish-btn"
                        data-testid="precision-card-publish"
                        onClick={() => void handlePublish(p.id)}
                        disabled={publishingId === p.id}
                      >
                        {publishingId === p.id
                          ? t('precision.publishing', 'Publishing…')
                          : t('precision.publish', 'Publish')}
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
