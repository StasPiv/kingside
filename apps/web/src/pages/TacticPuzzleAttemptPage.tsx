/**
 * KS-4361 / ADR-136 T9. Страница `/critical-moment/attempts/:id` —
 * разбор одной попытки текущего пользователя.
 *
 * Источник данных: `GET /critical-moment/attempts/:id` (KS-4356) →
 * `TacticAttemptDetail`. Включает стартовую позицию пазла,
 * `userMoves` через пробел (UCI), `bestMoveUci`, метрики попытки и
 * данные партии-источника.
 *
 * Раскладка:
 *   1. `<TacticPuzzlesSubNav />` сверху.
 *   2. Заголовок «Разбор попытки #...» + дата.
 *   3. Доска: пошаговое воспроизведение ходов пользователя
 *      (next/previous/reset/play) + подсветка правильного хода
 *      `bestMoveUci` поверх стартовой позиции.
 *   4. Карточка метаданных (исход/время/рейтинг/Δ/точность/WDL/...).
 *   5. Блок «Из партии» (`PuzzleSourceGame`) — переиспользуем компонент
 *      из /precision.
 *   6. Действия: открыть в мастерской / перерешать / назад к истории.
 *
 * 404 → понятная заглушка «Попытка не найдена» с кнопкой «Назад».
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess, type Square } from 'chess.js';
import type {
  PuzzleSourceGame as PuzzleSourceGameDto,
  TacticAttemptDetail,
} from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { PageSeo } from '../components/seo/PageSeo';
import { TacticPuzzlesSubNav } from '../components/tactic-puzzles/TacticPuzzlesSubNav';
import { PuzzleBoard } from '../components/PuzzleBoard';
import { PuzzleSourceGame } from '../components/puzzle/PuzzleSourceGame';
import { tacticPuzzleApi } from '../api/api-tactic-puzzle';
import { api } from '../api';
import { ApiError } from '../ApiError';
// KS-4492. PGN-сборка для открытия в мастерской через POST /analyses
// (унификация с Precision; см. SolveTacticPuzzlePage и
// PrecisionAttemptPage).
// KS-4608: `buildTacticPuzzlePgn` удалён — PGN теперь собирает
// backend через `POST /analyses/from-tactic-attempt`.

function sideFromFen(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
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

/**
 * Адаптер `TacticAttemptDetail` → `PuzzleSourceGameDto` (тот же
 * приём, что в SolveTacticPuzzlePage KS-4347 — позволяет переиспользовать
 * готовый компонент «Из партии»).
 */
function buildSourceGame(
  detail: TacticAttemptDetail,
): PuzzleSourceGameDto | undefined {
  if (!detail.sourceHeaders && !detail.sourceGameId) return undefined;
  const h = detail.sourceHeaders ?? {};
  return {
    white: h.White ?? undefined,
    black: h.Black ?? undefined,
    event: h.Event ?? undefined,
    date: h.Date ?? undefined,
    result: h.Result ?? undefined,
    archiveGameId: detail.sourceGameId ?? undefined,
  };
}

/**
 * Парсит `userMoves` (UCI через пробел) в массив объектов, готовых
 * для chess.js `move()`. Невалидные токены пропускаются.
 */
function parseUciMoves(s: string): { from: Square; to: Square; promotion?: string }[] {
  if (!s) return [];
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((uci) => ({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      promotion: uci.length > 4 ? uci[4] : undefined,
    }));
}

/**
 * По массиву ходов и стартовому FEN строит снимки `Chess` после каждого
 * полухода. `snapshots[0]` — стартовая позиция, `snapshots[i]` — после
 * i-го хода. Если ход не прошёл (битый PGN/невалидный UCI) — обрываем
 * массив на этом шаге.
 */
function buildLineSnapshots(
  startFen: string,
  moves: { from: Square; to: Square; promotion?: string }[],
): Chess[] {
  const out: Chess[] = [];
  let chess: Chess;
  try {
    chess = new Chess(startFen);
  } catch {
    return out;
  }
  out.push(new Chess(chess.fen()));
  for (const m of moves) {
    try {
      const next = new Chess(chess.fen());
      const res = next.move(m);
      if (!res) break;
      chess = next;
      out.push(new Chess(chess.fen()));
    } catch {
      break;
    }
  }
  return out;
}

export function TacticPuzzleAttemptPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [detail, setDetail] = useState<TacticAttemptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'not-found' | 'generic' | null>(null);

  useEffect(() => {
    if (!id) {
      setError('not-found');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    tacticPuzzleApi
      .getAttemptDetail(id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) setError('not-found');
        else setError('generic');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // ── Воспроизведение линии ───────────────────────────────────────
  const lineSnapshots = useMemo<Chess[]>(() => {
    if (!detail) return [];
    return buildLineSnapshots(detail.puzzle.fen, parseUciMoves(detail.userMoves));
  }, [detail]);

  const [ply, setPly] = useState(0); // 0 — стартовая позиция
  const [playing, setPlaying] = useState(false);
  const playTimerRef = useRef<number | null>(null);

  // Сбрасываем индекс при смене попытки.
  useEffect(() => {
    setPly(0);
    setPlaying(false);
  }, [detail?.id]);

  // Анимация автопроигрывания: каждый интервал — следующий ход.
  useEffect(() => {
    if (!playing) return;
    if (ply >= lineSnapshots.length - 1) {
      setPlaying(false);
      return;
    }
    playTimerRef.current = window.setTimeout(() => {
      setPly((p) => Math.min(p + 1, lineSnapshots.length - 1));
    }, 900);
    return () => {
      if (playTimerRef.current) {
        window.clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [playing, ply, lineSnapshots.length]);

  const currentGame: Chess | null =
    lineSnapshots.length > 0
      ? lineSnapshots[Math.min(ply, lineSnapshots.length - 1)]
      : null;

  // Подсветка правильного хода (стрелка) — только когда на стартовой
  // позиции пазла (ply=0) и линия начинается с user-хода.
  const orientation: 'white' | 'black' = detail
    ? sideFromFen(detail.puzzle.fen) === 'w'
      ? 'white'
      : 'black'
    : 'white';

  const [showBest, setShowBest] = useState(false);
  const bestArrows = useMemo(() => {
    if (!detail || !showBest || ply !== 0) return undefined;
    const uci = detail.puzzle.bestMoveUci;
    if (!uci || uci.length < 4) return undefined;
    return [
      {
        startSquare: uci.slice(0, 2),
        endSquare: uci.slice(2, 4),
        color: 'rgba(34, 197, 94, 0.85)',
      },
    ];
  }, [detail, showBest, ply]);

  const handleReset = useCallback(() => {
    setPlaying(false);
    setPly(0);
  }, []);
  const handlePrev = useCallback(() => {
    setPlaying(false);
    setPly((p) => Math.max(0, p - 1));
  }, []);
  const handleNext = useCallback(() => {
    setPlaying(false);
    setPly((p) => Math.min(lineSnapshots.length - 1, p + 1));
  }, [lineSnapshots.length]);
  const handlePlay = useCallback(() => {
    if (lineSnapshots.length <= 1) return;
    if (ply >= lineSnapshots.length - 1) setPly(0);
    setPlaying(true);
  }, [lineSnapshots.length, ply]);
  const handleStop = useCallback(() => setPlaying(false), []);

  // ── Действия ───────────────────────────────────────────────────
  //
  // KS-4492 → KS-4608. Открытие в мастерской: для авторизованного —
  // `POST /analyses/from-tactic-attempt { attemptId }` (KS-4607), backend
  // собирает PGN из связки `tactic_puzzle_attempts → tactic_puzzles` и
  // возвращает analysis-id. У этой страницы `attemptId` известен сразу
  // (`detail.id`), отдельный submitAttempt не нужен.
  // Гостю эта страница недоступна (pageState='guest'), но на всякий
  // случай оставляем `?fen=` fallback.
  const handleOpenWorkshop = useCallback(() => {
    if (!detail) return;
    const fallbackUrl = `/analysis?fen=${encodeURIComponent(detail.puzzle.fen)}`;
    const tab = window.open('about:blank', '_blank');
    const redirect = (url: string) => {
      if (tab) {
        try {
          tab.location.href = url;
        } catch {
          window.location.href = url;
        }
      } else {
        window.location.href = url;
      }
    };
    if (!user) {
      redirect(fallbackUrl);
      return;
    }
    api
      .post<{ id: string }>(
        '/analyses/from-tactic-attempt',
        { attemptId: detail.id },
      )
      .then((created) => redirect(`/analysis/${created.id}`))
      .catch((e) => {
        console.warn(
          'TacticPuzzleAttemptPage: from-tactic-attempt failed, fallback to ?fen=',
          e,
        );
        redirect(fallbackUrl);
      });
  }, [detail, user]);
  const handleReplay = useCallback(() => {
    if (!detail) return;
    navigate(`/critical-moment/${detail.puzzleId}`);
  }, [detail, navigate]);
  const handleBack = useCallback(() => {
    navigate('/critical-moment/history');
  }, [navigate]);

  // ── Render ─────────────────────────────────────────────────────
  const isGuest = !user;
  const pageState:
    | 'guest'
    | 'loading'
    | 'not-found'
    | 'error'
    | 'ready' = isGuest
    ? 'guest'
    : loading
      ? 'loading'
      : error === 'not-found'
        ? 'not-found'
        : error === 'generic'
          ? 'error'
          : 'ready';

  const shortId = detail ? detail.id.slice(0, 8) : id?.slice(0, 8) ?? '';
  const playedAt =
    detail ? formatPlayedAt(detail.createdAt, i18n.language) : '';

  return (
    <div
      className="tactic-puzzle-attempt"
      data-testid="tactic-puzzle-attempt"
      data-auth={isGuest ? 'guest' : 'user'}
      data-state={pageState}
    >
      <PageSeo
        ns="tacticPuzzles.history"
        path={`/critical-moment/attempts/${id ?? ''}`}
        noindex
      />
      <TacticPuzzlesSubNav />

      {pageState === 'guest' && (
        <section className="tactic-puzzle-attempt__guest" data-testid="tactic-puzzle-attempt-guest">
          <h2>{t('tacticPuzzle.history.guestTitle', 'Sign in to see history')}</h2>
          <Link to="/login" className="tactic-puzzle-attempt__guest-cta">
            {t('precision.history.guest.cta', 'Sign in')}
          </Link>
        </section>
      )}

      {pageState === 'loading' && (
        <p
          className="tactic-puzzle-attempt__status"
          data-testid="tactic-puzzle-attempt-loading"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}

      {pageState === 'not-found' && (
        <section
          className="tactic-puzzle-attempt__not-found"
          data-testid="tactic-puzzle-attempt-not-found"
        >
          <h2>{t('tacticPuzzle.attempt.notFoundTitle', 'Attempt not found')}</h2>
          <p>
            {t(
              'tacticPuzzle.attempt.notFoundMessage',
              'The link may be outdated, the attempt was removed, or it belongs to another user.',
            )}
          </p>
          <button type="button" onClick={handleBack}>
            {t('tacticPuzzle.attempt.backToHistory', 'Back to history')}
          </button>
        </section>
      )}

      {pageState === 'error' && (
        <div
          className="tactic-puzzle-attempt__status tactic-puzzle-attempt__status--error"
          data-testid="tactic-puzzle-attempt-error"
        >
          <p>{t('tacticPuzzle.attempt.loadError', 'Could not load attempt review.')}</p>
          <button type="button" onClick={() => window.location.reload()}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {pageState === 'ready' && detail && currentGame && (
        <>
          <header className="tactic-puzzle-attempt__header">
            <h1>
              {t('tacticPuzzle.attempt.title', 'Attempt review #{{id}}', {
                id: shortId,
              })}
            </h1>
            <div className="tactic-puzzle-attempt__date">
              {t('tacticPuzzle.attempt.playedAt', 'Played')}: {playedAt}
            </div>
          </header>

          <div className="tactic-puzzle-attempt__layout">
            <div className="tactic-puzzle-attempt__board-col">
              <PuzzleBoard
                game={currentGame}
                boardOrientation={orientation}
                enabled={false}
                onPieceDrop={() => false}
                lastMoveUci={null}
                boardKey={`${detail.id}-${ply}`}
                customArrows={bestArrows}
              />
              <div
                className="tactic-puzzle-attempt__controls"
                data-testid="tactic-puzzle-attempt-controls"
              >
                <button
                  type="button"
                  className="play-btn play-btn--secondary play-btn--compact"
                  onClick={handleReset}
                  data-testid="tactic-puzzle-attempt-reset"
                >
                  {t('tacticPuzzle.attempt.controls.reset', 'Reset to start')}
                </button>
                <button
                  type="button"
                  className="play-btn play-btn--secondary play-btn--compact"
                  onClick={handlePrev}
                  disabled={ply === 0}
                  data-testid="tactic-puzzle-attempt-prev"
                >
                  ←{' '}
                  {t('tacticPuzzle.attempt.controls.previous', 'Previous move')}
                </button>
                <button
                  type="button"
                  className="play-btn play-btn--secondary play-btn--compact"
                  onClick={handleNext}
                  disabled={ply >= lineSnapshots.length - 1}
                  data-testid="tactic-puzzle-attempt-next"
                >
                  {t('tacticPuzzle.attempt.controls.next', 'Next move')} →
                </button>
                {playing ? (
                  <button
                    type="button"
                    className="play-btn play-btn--compact"
                    onClick={handleStop}
                    data-testid="tactic-puzzle-attempt-stop"
                  >
                    {t('tacticPuzzle.attempt.controls.stop', 'Stop')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="play-btn play-btn--compact"
                    onClick={handlePlay}
                    disabled={lineSnapshots.length <= 1}
                    data-testid="tactic-puzzle-attempt-play"
                  >
                    {t('tacticPuzzle.attempt.controls.play', 'Play user moves')}
                  </button>
                )}
                <button
                  type="button"
                  className={`play-btn play-btn--secondary play-btn--compact${
                    showBest ? ' play-btn--active' : ''
                  }`}
                  onClick={() => setShowBest((v) => !v)}
                  data-testid="tactic-puzzle-attempt-show-best"
                >
                  {t(
                    'tacticPuzzle.attempt.controls.showBest',
                    'Show best move',
                  )}
                </button>
              </div>
            </div>

            <aside
              className="tactic-puzzle-attempt__sidebar"
              data-testid="tactic-puzzle-attempt-meta"
            >
              <dl className="tactic-puzzle-attempt__meta">
                <div>
                  <dt>{t('tacticPuzzle.attempt.labels.outcome', 'Outcome')}</dt>
                  <dd
                    className={`tactic-puzzle-attempt__outcome tactic-puzzle-attempt__outcome--${
                      detail.solved ? 'solved' : 'failed'
                    }`}
                  >
                    {detail.solved
                      ? t('tacticPuzzle.history.outcome.solved', 'Solved')
                      : t('tacticPuzzle.history.outcome.failed', 'Failed')}
                  </dd>
                </div>
                <div>
                  <dt>
                    {t('tacticPuzzle.attempt.labels.stopReason', 'Stop reason')}
                  </dt>
                  <dd>
                    {t(
                      `tacticPuzzle.history.stopReason.${detail.stopReason}`,
                      detail.stopReason,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>
                    {t('tacticPuzzle.attempt.labels.lineLength', 'User moves')}
                  </dt>
                  <dd>{detail.lineHalfMoves}</dd>
                </div>
                <div>
                  <dt>{t('tacticPuzzle.attempt.labels.duration', 'Time')}</dt>
                  <dd>{formatDuration(detail.timeMs)}</dd>
                </div>
                <div>
                  <dt>{t('tacticPuzzle.attempt.labels.rating', 'Rating')}</dt>
                  <dd>
                    {detail.ratingBefore} → {detail.ratingAfter}
                  </dd>
                </div>
                <div>
                  <dt>
                    {t('tacticPuzzle.attempt.labels.ratingDelta', 'Δ rating')}
                  </dt>
                  <dd
                    className={`tactic-puzzle-attempt__delta tactic-puzzle-attempt__delta--${
                      detail.ratingDelta > 0
                        ? 'up'
                        : detail.ratingDelta < 0
                          ? 'down'
                          : 'flat'
                    }`}
                  >
                    {detail.ratingDelta > 0
                      ? `↑ +${detail.ratingDelta}`
                      : detail.ratingDelta < 0
                        ? `↓ ${detail.ratingDelta}`
                        : '·'}
                  </dd>
                </div>
                {detail.movesAccuracy != null && (
                  <div>
                    <dt>
                      {t(
                        'tacticPuzzle.attempt.labels.movesAccuracy',
                        'Move accuracy',
                      )}
                    </dt>
                    <dd>
                      {Math.round(detail.movesAccuracy * 100)}%
                    </dd>
                  </div>
                )}
                {detail.precisionGrade != null && (
                  <div>
                    <dt>
                      {t(
                        'tacticPuzzle.attempt.labels.precisionGrade',
                        'Grade',
                      )}
                    </dt>
                    <dd>{detail.precisionGrade}/5</dd>
                  </div>
                )}
                {detail.wdlStart != null && (
                  <div>
                    <dt>
                      {t('tacticPuzzle.attempt.labels.wdlStart', 'WDL start')}
                    </dt>
                    <dd>{(detail.wdlStart * 100).toFixed(0)}%</dd>
                  </div>
                )}
                {detail.wdlEnd != null && (
                  <div>
                    <dt>
                      {t('tacticPuzzle.attempt.labels.wdlEnd', 'WDL end')}
                    </dt>
                    <dd>{(detail.wdlEnd * 100).toFixed(0)}%</dd>
                  </div>
                )}
                <div>
                  <dt>
                    {t('tacticPuzzle.attempt.labels.objective', 'Objective')}
                  </dt>
                  <dd>
                    {detail.objective === 'convertAdvantage'
                      ? t(
                          'puzzle.objective.convertAdvantage',
                          'Convert the advantage',
                        )
                      : t('puzzle.objective.saveEquality', 'Save the draw')}
                  </dd>
                </div>
              </dl>

              <div
                className="tactic-puzzle-attempt__actions"
                data-testid="tactic-puzzle-attempt-actions"
              >
                <button
                  type="button"
                  className="play-btn play-btn--compact"
                  onClick={handleReplay}
                  data-testid="tactic-puzzle-attempt-replay"
                >
                  {t('tacticPuzzle.attempt.actions.replay', 'Replay puzzle')}
                </button>
                <button
                  type="button"
                  className="play-btn play-btn--secondary play-btn--compact"
                  onClick={handleOpenWorkshop}
                  data-testid="tactic-puzzle-attempt-workshop"
                >
                  {t(
                    'tacticPuzzle.attempt.actions.openWorkshop',
                    'Open in workshop',
                  )}
                </button>
                <button
                  type="button"
                  className="play-btn play-btn--secondary play-btn--compact"
                  onClick={handleBack}
                  data-testid="tactic-puzzle-attempt-back"
                >
                  ← {t('tacticPuzzle.attempt.actions.back', 'Back to history')}
                </button>
              </div>

              <PuzzleSourceGame source={buildSourceGame(detail)} />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
