import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  GetGuessSessionResponse,
  GuessMoveDto,
  GuessVerdict,
} from '@kingside/shared';
import { GuessSubNav } from '../components/guess/GuessSubNav';
import { guessApi } from '../api/guessApi';
import { archiveApi } from '../api/archive';

/**
 * KS-3514 (ADR-093 follow-up) — страница `/guess/sessions/:id` с
 * разбором конкретного прохождения «Угадай ход».
 *
 * Backend: `GET /guess/sessions/:id` (KS-3508 + KS-3514 расширение
 * d6fb1e09) отдаёт `session` (включая `pgn`), `moves[]` с `verdict`,
 * плюс `userPoints`/`playerPoints` для табло «ты : игрок».
 * Работает для любого статуса; owner-check на бекенде.
 *
 * Кнопка «Open in analysis» доступна только для `status='finished'` —
 * POST `/to-analysis` (KS-3461) требует finished. Для active/abandoned
 * рисуем disabled-кнопку с пояснительным `title`.
 */

interface PgnContext {
  white: string;
  black: string;
  event: string | null;
}

const DASH = '—';

/**
 * KS-3521: парсим PGN headers через chess.js. Если headers пустые или
 * содержат `?` (анонимная партия) — возвращаем `'—'`. Внешний код
 * (`maybeBackfillFromArchive`) добывает имена из `gameSource='archive'`
 * через GET /archive/games/:id.
 */
function parsePgnContext(pgn: string | null | undefined): PgnContext {
  if (!pgn) return { white: DASH, black: DASH, event: null };
  try {
    const g = new Chess();
    g.loadPgn(pgn);
    const h = g.header();
    const cleanup = (v?: string): string => {
      const trimmed = v?.trim();
      if (!trimmed || trimmed === '?') return DASH;
      return trimmed;
    };
    return {
      white: cleanup(h.White),
      black: cleanup(h.Black),
      event: h.Event?.trim() && h.Event.trim() !== '?' ? h.Event.trim() : null,
    };
  } catch {
    return { white: DASH, black: DASH, event: null };
  }
}

/** UCI → SAN. Если не получится — возвращаем UCI как fallback. */
function uciToSan(fenBefore: string, uci: string): string {
  try {
    const g = new Chess(fenBefore);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4) : undefined;
    const move = g.move({ from, to, promotion });
    return move?.san ?? uci;
  } catch {
    return uci;
  }
}

function moveNumberLabel(ply: number): string {
  // ply 1-based, как в GuessMoveDto. Для plyN (1-based) полу-ход N:
  // moveNo = ceil(ply/2); side = ply % 2 === 1 ? 'white' : 'black'.
  const moveNo = Math.ceil(ply / 2);
  const dots = ply % 2 === 1 ? '.' : '...';
  return `${moveNo}${dots}`;
}

const VERDICT_TONE: Record<GuessVerdict, string> = {
  strongest: 'guess-review__verdict--strongest',
  betterThanPlayer: 'guess-review__verdict--better',
  asPlayer: 'guess-review__verdict--equal',
  weaker: 'guess-review__verdict--weaker',
};

export interface GuessSessionReviewPageProps {
  /** DI для тестов. */
  getSession?: (id: string) => Promise<GetGuessSessionResponse>;
  toAnalysis?: (id: string) => Promise<{ url: string }>;
  /**
   * KS-3521: DI для archive-fallback (когда pgn без headers).
   * Совместима с `archiveApi.getArchiveGameById`.
   */
  getArchiveGame?: (
    gameRef: string,
  ) => Promise<{
    white: { name: string | null };
    black: { name: string | null };
    event: string | null;
  }>;
}

export function GuessSessionReviewPage({
  getSession,
  toAnalysis,
  getArchiveGame,
}: GuessSessionReviewPageProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const [data, setData] = useState<GetGuessSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  // KS-3521: явный error-state для кнопки «Open in analysis», чтобы
  // пользователь видел причину, а не просто «ничего не происходит».
  const [openError, setOpenError] = useState<string | null>(null);
  // KS-3521: имена из archive-fallback (когда PGN без headers).
  const [archiveContext, setArchiveContext] = useState<PgnContext | null>(
    null,
  );

  const fetchSession = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const get = getSession ?? ((sid: string) => guessApi.getSession(sid));
      const res = await get(id);
      setData(res);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t('guess.review.error', 'Failed to load session'),
      );
    } finally {
      setLoading(false);
    }
  }, [id, getSession, t]);

  useEffect(() => {
    void fetchSession();
  }, [fetchSession]);

  const pgnCtx = useMemo(
    () => parsePgnContext(data?.session.pgn ?? null),
    [data?.session.pgn],
  );

  // KS-3521: если PGN-headers пустые (white/black=='—'), а сессия
  // была создана из архива — добываем имена через GET /archive/games/:id
  // (gameRef = archiveGameId, ADR-091). Делаем один раз на mount data.
  useEffect(() => {
    if (!data) return;
    setArchiveContext(null);
    const needsBackfill =
      pgnCtx.white === DASH || pgnCtx.black === DASH || !pgnCtx.event;
    if (!needsBackfill) return;
    const src = data.session.gameSource;
    const ref = data.session.gameRef;
    if (src !== 'archive' || !ref) return;
    const get =
      getArchiveGame ?? ((r: string) => archiveApi.getArchiveGameById(r));
    let cancelled = false;
    void (async () => {
      try {
        const g = await get(ref);
        if (cancelled) return;
        setArchiveContext({
          white: g.white?.name?.trim() || DASH,
          black: g.black?.name?.trim() || DASH,
          event: g.event?.trim() || null,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[guess-review] archive backfill failed', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, pgnCtx, getArchiveGame]);

  // Финальный контекст — PGN headers c приоритетом, иначе archive-backfill.
  const displayCtx = useMemo<PgnContext>(() => {
    if (!archiveContext) return pgnCtx;
    return {
      white: pgnCtx.white !== DASH ? pgnCtx.white : archiveContext.white,
      black: pgnCtx.black !== DASH ? pgnCtx.black : archiveContext.black,
      event: pgnCtx.event ?? archiveContext.event,
    };
  }, [pgnCtx, archiveContext]);

  const onOpenInAnalysis = useCallback(async () => {
    if (!id || opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const call = toAnalysis ?? ((sid: string) => guessApi.toAnalysis(sid));
      const res = await call(id);
      if (!res?.url) {
        throw new Error('Empty url from server');
      }
      navigate(res.url);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[guess-review] toAnalysis failed', e);
      const msg = e instanceof Error ? e.message : String(e);
      setOpenError(
        t('guess.review.openInAnalysisError', {
          defaultValue: 'Could not open the analysis: {{msg}}',
          msg,
        }),
      );
      setOpening(false);
    }
  }, [id, opening, toAnalysis, navigate, t]);

  if (loading) {
    return (
      <div
        className="guess-review-page"
        data-testid="guess-review-page"
        data-state="loading"
      >
        <GuessSubNav />
        <div className="guess-review-page__skeleton" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        className="guess-review-page"
        data-testid="guess-review-page"
        data-state="error"
      >
        <GuessSubNav />
        <header className="guess-review-page__header">
          <Link to="/guess/history" className="guess-review-page__back">
            ← {t('guess.review.backToHistory', 'Back to history')}
          </Link>
        </header>
        <p data-testid="guess-review-error">
          {error ?? t('guess.review.error', 'Failed to load session')}
        </p>
        <button type="button" onClick={() => void fetchSession()}>
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  const { session, moves, userPoints, playerPoints } = data;
  const isFinished = session.status === 'finished';
  const totalRounds = moves.length;
  const acc = (n: number | null): string =>
    n == null ? '—' : `${Math.round(n)}%`;
  const stars =
    session.userStars != null ? `${session.userStars}★` : '—';

  return (
    <div
      className="guess-review-page"
      data-testid="guess-review-page"
      data-state="ready"
      data-status={session.status}
    >
      <GuessSubNav />

      <header className="guess-review-page__header">
        <Link
          to="/guess/history"
          className="guess-review-page__back"
          data-testid="guess-review-back"
        >
          ← {t('guess.review.backToHistory', 'Back to history')}
        </Link>
        <h1
          className="guess-review-page__title"
          data-testid="guess-review-title"
        >
          {displayCtx.white} {t('guess.review.vs', 'vs')} {displayCtx.black}
        </h1>
        {displayCtx.event && (
          <p
            className="guess-review-page__event"
            data-testid="guess-review-event"
          >
            {displayCtx.event}
          </p>
        )}
        <p
          className="guess-review-page__meta"
          data-testid="guess-review-meta"
        >
          <span data-testid="guess-review-side">
            {t('guess.review.guessingFor', 'Guessing for')}:{' '}
            {t(`guess.setup.${session.side}`, session.side)}
          </span>
          {' · '}
          <span data-testid="guess-review-status">
            {t(`guess.review.status.${session.status}`, session.status)}
          </span>
        </p>
      </header>

      <section
        className="guess-review-page__metrics"
        data-testid="guess-review-metrics"
      >
        <div
          className="guess-review-page__metric"
          data-testid="guess-review-metric-your-acc"
        >
          <div className="guess-review-page__metric-value">
            {acc(session.userAccuracy)}
          </div>
          <div className="guess-review-page__metric-label">
            {t('guess.review.yourAccuracy', 'Your accuracy')}
          </div>
        </div>
        <div
          className="guess-review-page__metric"
          data-testid="guess-review-metric-player-acc"
        >
          <div className="guess-review-page__metric-value">
            {acc(session.playerAccuracy)}
          </div>
          <div className="guess-review-page__metric-label">
            {t('guess.review.playerAccuracy', 'Player accuracy')}
          </div>
        </div>
        <div
          className="guess-review-page__metric"
          data-testid="guess-review-metric-scoreboard"
          data-user-points={userPoints}
          data-player-points={playerPoints}
        >
          <div className="guess-review-page__metric-value">
            {userPoints} : {playerPoints}
          </div>
          <div className="guess-review-page__metric-label">
            {t('guess.review.scoreboard', 'You : Game')}
          </div>
        </div>
        <div
          className="guess-review-page__metric"
          data-testid="guess-review-metric-rounds"
        >
          <div className="guess-review-page__metric-value">
            {totalRounds}
          </div>
          <div className="guess-review-page__metric-label">
            {t('guess.review.rounds', 'Rounds')}
          </div>
        </div>
        <div
          className="guess-review-page__metric"
          data-testid="guess-review-metric-stars"
        >
          <div className="guess-review-page__metric-value">{stars}</div>
          <div className="guess-review-page__metric-label">
            {t('guess.review.stars', 'Stars')}
          </div>
        </div>
        <div
          className="guess-review-page__metric"
          data-testid="guess-review-metric-score"
        >
          <div className="guess-review-page__metric-value">
            {session.score}
          </div>
          <div className="guess-review-page__metric-label">
            {t('guess.review.score', 'Score')}
          </div>
        </div>
      </section>

      <section
        className="guess-review-page__actions"
        data-testid="guess-review-actions"
      >
        <button
          type="button"
          className="guess-review-page__to-analysis"
          data-testid="guess-review-to-analysis"
          disabled={!isFinished || opening}
          aria-disabled={!isFinished || opening}
          title={
            !isFinished
              ? t(
                  'guess.review.finishToAnalyzeHint',
                  'Finish the session to open the analysis',
                )
              : ''
          }
          onClick={() => void onOpenInAnalysis()}
        >
          {opening
            ? t('guess.history.opening', 'Opening…')
            : t('guess.review.openInAnalysis', 'Open in analysis →')}
        </button>
        {openError && (
          <p
            className="guess-review-page__open-error"
            data-testid="guess-review-open-error"
            role="alert"
          >
            {openError}
          </p>
        )}
      </section>

      <section
        className="guess-review-page__moves"
        data-testid="guess-review-moves"
      >
        <h2 className="guess-review-page__moves-title">
          {t('guess.review.movesTitle', 'Moves')}
        </h2>
        {moves.length === 0 ? (
          <p
            className="guess-review-page__moves-empty"
            data-testid="guess-review-moves-empty"
          >
            {t(
              'guess.review.movesEmpty',
              'No moves yet in this session',
            )}
          </p>
        ) : (
          <ol className="guess-review-page__moves-list">
            {moves.map((m: GuessMoveDto) => {
              const userSan = uciToSan(m.fenBefore, m.userUci);
              const playedSan = uciToSan(m.fenBefore, m.playedUci);
              const isExact = m.userUci === m.playedUci;
              return (
                <li
                  key={m.ply}
                  className="guess-review-page__move"
                  data-testid={`guess-review-move-${m.ply}`}
                  data-verdict={m.verdict}
                >
                  <span className="guess-review-page__move-no">
                    {moveNumberLabel(m.ply)}
                  </span>
                  <span className="guess-review-page__move-user">
                    {userSan}
                  </span>
                  {!isExact && (
                    <span
                      className="guess-review-page__move-played"
                      title={t(
                        'guess.review.actualPlayedHint',
                        'Actually played in the game',
                      )}
                    >
                      ({playedSan})
                    </span>
                  )}
                  <span
                    className={`guess-review-page__verdict ${VERDICT_TONE[m.verdict] ?? ''}`}
                    data-testid={`guess-review-move-verdict-${m.ply}`}
                  >
                    {t(`guess.verdictShort.${m.verdict}`, m.verdict)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
