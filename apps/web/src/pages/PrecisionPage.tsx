import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import type { PuzzleStatsByMode } from '@kingside/shared';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

/**
 * KS-2484 (ADR-044) — список play-vs-engine пазлов.
 *
 * Backend API (rev:113, KS-2472) принимает фильтр
 * `solutionMode=play-vs-engine` и возвращает массив пазлов с полем
 * `playVsEngine: { blunderMove, wdlAfterBlunder, winThreshold,
 * failThreshold, halfMovesN }`. На текущий момент таких пазлов в
 * генерации мало (~единицы) — фоновое заполнение KS-2466 ещё идёт.
 *
 * Минимальный UI: карточки с мини-доской (FEN-превью), темой,
 * рейтингом, кликом на `/puzzle/:id`. Если пазлов нет — плейсхолдер.
 *
 * # DOM
 *
 *   <div class="play-vs-engine-puzzles" data-testid="play-vs-engine-puzzles"
 *        data-state="loading|ready|empty|error">
 *     <h1>…</h1>
 *     <p class="play-vs-engine-puzzles__intro">…</p>
 *     <div class="play-vs-engine-puzzles__list">
 *       <article data-testid="play-vs-engine-card" data-puzzle-id="…" />
 *       …
 *     </div>
 *   </div>
 */

interface PlayVsEnginePuzzleDto {
  id: string;
  fen: string;
  rating: number;
  themes: string[];
  source: string;
  solutionMode: 'play-vs-engine';
  playVsEngine?: {
    blunderMove?: string;
    wdlAfterBlunder?: number;
    winThreshold?: number;
    failThreshold?: number;
    halfMovesN?: number;
  };
}

const LIMIT = 20;

/** Сторона на ходу из FEN — для ориентации мини-доски (нижняя сторона). */
function sideFromFen(fen: string): 'white' | 'black' {
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'black' : 'white';
}

// KS-2542 (ADR-048): компонент переименован `PlayVsEnginePuzzlesPage`
// → `PrecisionPage` после переезда на роут `/precision`. Внутренние
// CSS-классы и testid'ы пока сохраняем — они не часть API.

/**
 * KS-2545 / ADR-048 §6: top-блок stats на главной /precision.
 * Источники:
 *  - `byMode['play-vs-engine']` из `GET /puzzles/stats/me` (KS-2493) —
 *    `attempts` (totalAttempted) и `solved` (totalSolved).
 *  - Последняя попытка в режиме play-vs-engine — из `GET /puzzles/attempts`
 *    (KS-2494). Берём первый attempt с `puzzle.solutionMode === 'play-vs-engine'`
 *    (бэкенд сортирует по `createdAt desc`). `null` если попыток нет.
 *
 * `byMode['play-vs-engine']` — внутренний API-маркер, не меняется
 * (KS-2544 i18n переименование не затрагивает контракты бэка).
 */
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

export function PrecisionPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [puzzles, setPuzzles] = useState<PlayVsEnginePuzzleDto[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>(
    'loading',
  );
  const [stats, setStats] = useState<PrecisionStatsState | null>(null);

  const fetchPuzzles = useCallback(async () => {
    setState('loading');
    try {
      const data = await api.get<PlayVsEnginePuzzleDto[]>(
        `/puzzles?solutionMode=play-vs-engine&limit=${LIMIT}`,
      );
      const list = Array.isArray(data) ? data : [];
      setPuzzles(list);
      setState(list.length === 0 ? 'empty' : 'ready');
    } catch {
      setPuzzles([]);
      setState('error');
    }
  }, []);

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
    void fetchPuzzles();
  }, [fetchPuzzles]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  return (
    <div
      className="play-vs-engine-puzzles"
      data-testid="play-vs-engine-puzzles"
      data-state={state}
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

      {state === 'loading' && (
        <p
          className="play-vs-engine-puzzles__status"
          data-testid="play-vs-engine-loading"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}

      {state === 'error' && (
        <div
          className="play-vs-engine-puzzles__status play-vs-engine-puzzles__status--error"
          data-testid="play-vs-engine-error"
        >
          <p>{t('precision.loadError', 'Could not load puzzles.')}</p>
          <button type="button" onClick={() => void fetchPuzzles()}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {state === 'empty' && (
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

      {state === 'ready' && (
        <div className="play-vs-engine-puzzles__list">
          {puzzles.map((p) => {
            const orientation = sideFromFen(p.fen);
            const onClick = () =>
              navigate(`/puzzle/${p.id}?source=play-vs-engine`);
            return (
              <article
                key={p.id}
                className="play-vs-engine-card"
                data-testid="play-vs-engine-card"
                data-puzzle-id={p.id}
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
                  </div>
                  <div className="play-vs-engine-card__themes">
                    {p.themes.slice(0, 3).map((theme) => (
                      <span
                        key={theme}
                        className="play-vs-engine-card__theme-tag"
                        data-testid="play-vs-engine-card-theme"
                      >
                        {t(`puzzleBrowser.themes.${theme}`, theme)}
                      </span>
                    ))}
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
                  <button
                    type="button"
                    className="play-vs-engine-card__solve-btn"
                    data-testid="play-vs-engine-card-solve"
                    onClick={onClick}
                  >
                    {t('puzzleBrowser.solve', 'Solve')}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
