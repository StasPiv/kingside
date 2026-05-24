/**
 * KS-3273 (ADR-077 §2.8 #4) + KS-3274 (UX polish). Сессия тренировки —
 * доска + бот + контролы + UX.
 *
 * UX-полировка (KS-3274):
 *  - Hint показывает стрелку лучшего хода на доске (`customArrows` в
 *    `PuzzleBoard`), стрелка живёт до следующего хода/undo/giveup.
 *  - Wrong-popup: при попытке `wrong` поверх доски открывается модалка
 *    с ожидаемыми ходами и CTA «Попробовать ещё раз» / «Показать ответ».
 *  - Streak-индикатор: цвет меняется по длине (3→зелёный, 4→синий,
 *    5+ → фиолетовый + ×1.2 badge), вычисляем локально по correctMoves
 *    с обнулением на любой wrong.
 *  - Анимация бот-хода: задержка `BOT_DELAY_MS` после применения нашего
 *    хода + sound `move/capture`.
 *  - Auto-flip: orientation берётся ровно из `session.side`.
 *  - Sounds: useSounds — `puzzle-correct` для правильного хода,
 *    `puzzle-incorrect` для ошибки, `move`/`capture` для бота.
 *
 * Поток без изменений из M1: discriminated union `/move` обрабатываем
 * через типгварды (`isCorrectMove`/`isWrongMove`/`isLineCompleteMove`),
 * `responseTimeMs = now − positionShownAtRef` для fast-bonus/SRS.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import { PuzzleBoard } from '../../components/PuzzleBoard';
import { useSounds, soundEventFromSan } from '../../hooks/useSounds';
import {
  isCorrectMove,
  isLineCompleteMove,
  isLineRestartMove,
  isTreeCompleteMove,
  isWrongMove,
  OPENING_TRAINER_SCORING,
} from '@kingside/shared';
import type {
  OpeningTrainerMoveResponse,
  OpeningTrainerSessionDto,
  StartOpeningTrainerSessionResponse,
} from '@kingside/shared';

interface LocationState {
  initialBotMove?: StartOpeningTrainerSessionResponse['initialBotMove'];
  session?: OpeningTrainerSessionDto;
}

type Feedback =
  | { kind: 'correct'; scoreDelta: number }
  | { kind: 'wrong'; expected: Array<{ moveUci: string; moveSan: string }> }
  | { kind: 'line-complete' }
  // KS-3277: бэк автоматически перенёс доску на ближайшую развилку
  // с непройденными ходами — продолжаем сессию.
  | { kind: 'line-restart' }
  // KS-3277: всё дерево пройдено без ошибок — сессия закрыта на бэке,
  // фронт показывает финал и редиректит на /result.
  | { kind: 'tree-complete' }
  | { kind: 'hint'; moveSan: string }
  | null;

const BOT_DELAY_MS = 420;
const HINT_ARROW_COLOR = 'rgba(56, 189, 248, 0.75)';

function uciSquares(uci: string): { from: string; to: string } | null {
  if (!uci || uci.length < 4) return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

/**
 * KS-3274: streak — мы не получаем явный counter от бэка в M1, поэтому
 * аппроксимируем: длинной последовательности `correctMoves` без новых
 * `wrongMoves`. Сбрасываем при изменении wrongMoves. Источник истины
 * остаётся `score` (KS-3272 backend применяет multiplier там).
 */
function useLocalStreak(session: OpeningTrainerSessionDto | null): number {
  const lastWrongRef = useRef<number>(session?.wrongMoves ?? 0);
  const streakRef = useRef<number>(0);
  const baselineCorrectRef = useRef<number>(session?.correctMoves ?? 0);

  if (!session) return 0;
  if (session.wrongMoves > lastWrongRef.current) {
    // Был новый wrong — обнулить
    streakRef.current = 0;
    baselineCorrectRef.current = session.correctMoves;
  }
  streakRef.current = Math.max(0, session.correctMoves - baselineCorrectRef.current);
  lastWrongRef.current = session.wrongMoves;
  return streakRef.current;
}

function streakColor(streak: number): { color: string; bonus: boolean } {
  if (streak >= OPENING_TRAINER_SCORING.streakThreshold) {
    return { color: '#facc15', bonus: true }; // golden + multiplier
  }
  if (streak >= 4) return { color: '#a78bfa', bonus: false }; // violet
  if (streak >= 3) return { color: '#38bdf8', bonus: false }; // sky
  if (streak >= 2) return { color: '#4ade80', bonus: false }; // green
  return { color: '#9ca3af', bonus: false }; // gray
}

export function OpeningTrainerSessionPage() {
  const { t } = useTranslation();
  const { id, sid } = useParams<{ id: string; sid: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { playSound } = useSounds();
  const incoming = (location.state as LocationState | null) ?? null;

  const [session, setSession] = useState<OpeningTrainerSessionDto | null>(
    incoming?.session ?? null,
  );
  const [game, setGame] = useState<Chess | null>(null);
  const [lastMoveUci, setLastMoveUci] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [hintArrowUci, setHintArrowUci] = useState<string | null>(null);
  const [wrongModalOpen, setWrongModalOpen] = useState(false);
  const positionShownAtRef = useRef<number>(Date.now());
  const streak = useLocalStreak(session);

  // Bootstrap — если пришли без state, грузим сессию.
  useEffect(() => {
    if (!sid) return;
    if (incoming?.session) return;
    let cancelled = false;
    openingTrainerApi
      .getSession(sid)
      .then((r) => {
        if (cancelled) return;
        setSession(r.session);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof ApiError
            ? err.message
            : t('openingTrainer.errors.loadSessionFailed', 'Failed to load session');
        setLoadError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [sid, incoming?.session, t]);

  // Init Chess board from session.currentFen.
  useEffect(() => {
    if (!session) return;
    try {
      const chess = new Chess(session.currentFen);
      setGame(chess);
      const last = session.currentPath[session.currentPath.length - 1];
      setLastMoveUci(last ?? null);
      positionShownAtRef.current = Date.now();
    } catch {
      setLoadError(
        t('openingTrainer.errors.invalidFen', 'Invalid position from server'),
      );
    }
  }, [session, t]);

  // Если у сессии status=finished — перебрасываем на result.
  useEffect(() => {
    if (session?.status === 'finished') {
      navigate(`/opening-trainer/${id}/session/${sid}/result`, { replace: true });
    }
  }, [session?.status, id, sid, navigate]);

  const isPromotionMove = useCallback(
    (from: string, to: string): boolean => {
      if (!game) return false;
      const piece = game.get(from as never);
      if (!piece || piece.type !== 'p') return false;
      const targetRank = to[1];
      return (
        (piece.color === 'w' && targetRank === '8') ||
        (piece.color === 'b' && targetRank === '1')
      );
    },
    [game],
  );

  const applyServerResponseAfterCorrect = useCallback(
    (newFen: string, botMove: { moveUci: string; moveSan: string; newFen: string } | null) => {
      try {
        const afterOurs = new Chess(newFen);
        setGame(afterOurs);
      } catch {
        /* ignore */
      }
      if (botMove) {
        // KS-3274: анимация — короткая пауза + звук, чтобы пользователь
        // визуально успел увидеть наш ход до бот-ответа.
        setTimeout(() => {
          try {
            const afterBot = new Chess(botMove.newFen);
            setGame(afterBot);
            setLastMoveUci(botMove.moveUci);
            playSound(soundEventFromSan(botMove.moveSan));
            positionShownAtRef.current = Date.now();
          } catch {
            /* ignore */
          }
        }, BOT_DELAY_MS);
      } else {
        positionShownAtRef.current = Date.now();
      }
    },
    [playSound],
  );

  const handleMoveResponse = useCallback(
    (res: OpeningTrainerMoveResponse) => {
      setHintArrowUci(null); // любой ход скрывает hint-стрелку
      if (isCorrectMove(res)) {
        setSession(res.session);
        setLastMoveUci(null);
        setFeedback({ kind: 'correct', scoreDelta: res.scoreDelta });
        playSound('puzzle-correct');
        applyServerResponseAfterCorrect(res.newFen, res.botMove);
      } else if (isWrongMove(res)) {
        setSession(res.session);
        setFeedback({ kind: 'wrong', expected: res.expectedMoves });
        setWrongModalOpen(true);
        playSound('puzzle-incorrect');
        try {
          setGame(new Chess(res.session.currentFen));
        } catch {
          /* ignore */
        }
      } else if (isLineRestartMove(res)) {
        // KS-3280 (fix регрессии KS-3277): бэк в KS-3278 hotfix
        // специально гарантирует `newFen != session.currentFen` для
        // line-restart (см. backend `handleLineComplete`). При наивном
        // `setSession(res.session)` срабатывает наш useEffect на
        // session-change и пересобирает game из `session.currentFen` —
        // т.е. на промежуточную (старую) позицию, а НЕ на newFen.
        // Доска не двигается, хотя UI показывает фидбек «↪ переходим
        // к следующему варианту».
        //
        // Патчим `currentFen = newFen` перед setSession: тогда useEffect
        // соберёт Chess из правильной fen. setGame в этой ветке больше
        // не нужен — useEffect сделает это сам.
        setSession({ ...res.session, currentFen: res.newFen });
        setFeedback({ kind: 'line-restart' });
        playSound('game-start');
        const lastInPath = res.newPath[res.newPath.length - 1];
        setLastMoveUci(lastInPath ?? null);
        if (res.botMove) {
          const bot = res.botMove;
          setTimeout(() => {
            try {
              setGame(new Chess(bot.newFen));
              setLastMoveUci(bot.moveUci);
              playSound(soundEventFromSan(bot.moveSan));
              positionShownAtRef.current = Date.now();
            } catch {
              /* ignore */
            }
          }, BOT_DELAY_MS);
        } else {
          positionShownAtRef.current = Date.now();
        }
      } else if (isTreeCompleteMove(res)) {
        // KS-3277: всё дерево пройдено без ошибок. Бэк выставил
        // session.status='finished' (подтверждено backend ACK), наш
        // useEffect ниже редиректит на /result, страница unmount'ится —
        // race с useEffect-на-session не страшен. Тут только UX.
        setSession(res.session);
        setFeedback({ kind: 'tree-complete' });
        playSound('puzzle-gameover');
        try {
          setGame(new Chess(res.newFen));
        } catch {
          /* ignore */
        }
      } else if (isLineCompleteMove(res)) {
        setSession(res.session);
        // Legacy variant (до KS-3277). В новом flow не приходит,
        // но обработчик оставлен на случай rollback'а контракта.
        setFeedback({ kind: 'line-complete' });
        playSound('game-end');
        try {
          setGame(new Chess(res.newFen));
        } catch {
          /* ignore */
        }
      }
    },
    [playSound, applyServerResponseAfterCorrect],
  );

  const sendMove = useCallback(
    async (uci: string) => {
      if (!sid || submitting) return;
      setSubmitting(true);
      setFeedback(null);
      const responseTimeMs = Date.now() - positionShownAtRef.current;
      try {
        const res = await openingTrainerApi.sendMove(sid, {
          moveUci: uci,
          responseTimeMs,
        });
        handleMoveResponse(res);
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.message
            : t('openingTrainer.errors.moveFailed', 'Move failed');
        setLoadError(msg);
        if (session) {
          try {
            setGame(new Chess(session.currentFen));
          } catch {
            /* ignore */
          }
        }
      } finally {
        setSubmitting(false);
      }
    },
    [sid, submitting, t, session, handleMoveResponse],
  );

  const onPieceDrop = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      sourceSquare: string;
      targetSquare: string | null;
    }): boolean => {
      if (!targetSquare || !game || submitting || session?.status !== 'active') {
        return false;
      }
      const promotion = isPromotionMove(sourceSquare, targetSquare) ? 'q' : undefined;
      const test = new Chess(game.fen());
      const result = test.move({
        from: sourceSquare,
        to: targetSquare,
        promotion,
      });
      if (!result) return false;
      setGame(test);
      const uci = sourceSquare + targetSquare + (promotion ?? '');
      setLastMoveUci(uci);
      playSound(soundEventFromSan(result.san));
      void sendMove(uci);
      return true;
    },
    [game, submitting, session?.status, isPromotionMove, sendMove, playSound],
  );

  const handleHint = useCallback(async () => {
    if (!sid || submitting) return;
    setSubmitting(true);
    try {
      const res = await openingTrainerApi.hint(sid);
      setSession(res.session);
      setFeedback({ kind: 'hint', moveSan: res.hint.moveSan });
      setHintArrowUci(res.hint.moveUci);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t('openingTrainer.errors.hintFailed', 'Hint failed');
      setLoadError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [sid, submitting, t]);

  const handleUndo = useCallback(async () => {
    if (!sid || submitting) return;
    setSubmitting(true);
    setFeedback(null);
    setHintArrowUci(null);
    try {
      const res = await openingTrainerApi.undo(sid);
      setSession(res.session);
      try {
        setGame(new Chess(res.newFen));
      } catch {
        /* ignore */
      }
      positionShownAtRef.current = Date.now();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t('openingTrainer.errors.undoFailed', 'Undo failed');
      setLoadError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [sid, submitting, t]);

  const handleGiveup = useCallback(async () => {
    if (!sid || submitting) return;
    setSubmitting(true);
    setWrongModalOpen(false);
    try {
      const res = await openingTrainerApi.giveup(sid);
      setSession(res.session);
      setFeedback({ kind: 'wrong', expected: res.expectedMoves });
      setHintArrowUci(null);
      try {
        if (res.botMove) {
          setGame(new Chess(res.botMove.newFen));
          setLastMoveUci(res.botMove.moveUci);
          playSound(soundEventFromSan(res.botMove.moveSan));
        } else {
          setGame(new Chess(res.newFen));
        }
      } catch {
        /* ignore */
      }
      positionShownAtRef.current = Date.now();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t('openingTrainer.errors.giveupFailed', 'Giveup failed');
      setLoadError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [sid, submitting, t, playSound]);

  const handleFinish = useCallback(async () => {
    if (!sid || finishing) return;
    setFinishing(true);
    try {
      const res = await openingTrainerApi.finish(sid);
      navigate(`/opening-trainer/${id}/session/${sid}/result`, {
        replace: true,
        state: { session: res.session, summary: res.summary },
      });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t('openingTrainer.errors.finishFailed', 'Finish failed');
      setLoadError(msg);
      setFinishing(false);
    }
  }, [sid, finishing, navigate, id, t]);

  const handleRetryAfterWrong = useCallback(() => {
    setWrongModalOpen(false);
    setFeedback(null);
  }, []);

  // KS-3274: auto-flip — берём ровно session.side.
  const orientation: 'white' | 'black' = session?.side ?? 'white';

  const customArrows = useMemo(() => {
    const sq = hintArrowUci ? uciSquares(hintArrowUci) : null;
    if (!sq) return undefined;
    return [{ startSquare: sq.from, endSquare: sq.to, color: HINT_ARROW_COLOR }];
  }, [hintArrowUci]);

  const boardEnabled = useMemo(
    () => Boolean(session && session.status === 'active' && !submitting && game),
    [session, submitting, game],
  );

  if (loadError && !session) {
    return (
      <div className="error" data-testid="opening-trainer-session-error">
        {loadError}
      </div>
    );
  }
  if (!session || !game) {
    return <div className="loading">{t('common.loading')}</div>;
  }

  const expectedSide =
    session.side === 'white'
      ? game.turn() === 'w'
      : game.turn() === 'b';

  const streakStyle = streakColor(streak);

  return (
    <div className="opening-trainer-session" data-testid="opening-trainer-session">
      <header className="opening-trainer-session__header">
        <h1>{t('openingTrainer.session.title', 'Opening training')}</h1>
        <div className="opening-trainer-session__counters">
          <span data-testid="opening-trainer-score">
            {t('openingTrainer.session.score', 'Score')}: <b>{session.score}</b>
          </span>
          <span
            className="opening-trainer-streak"
            data-testid="opening-trainer-streak"
            data-bonus={streakStyle.bonus ? 'true' : 'false'}
            style={{ color: streakStyle.color }}
          >
            🔥 <b>{streak}</b>
            {streakStyle.bonus && (
              <span
                className="opening-trainer-streak__badge"
                data-testid="opening-trainer-streak-bonus"
              >
                ×{OPENING_TRAINER_SCORING.streakMultiplier}
              </span>
            )}
          </span>
          <span>
            ✓ <b>{session.correctMoves}</b>
          </span>
          <span>
            ✗ <b>{session.wrongMoves}</b>
          </span>
          <span>
            💡 <b>{session.hintsUsed}</b>
          </span>
        </div>
      </header>

      <div className="opening-trainer-session__body">
        <div className="opening-trainer-session__board">
          <PuzzleBoard
            game={game}
            boardOrientation={orientation}
            enabled={boardEnabled && expectedSide && !wrongModalOpen}
            onPieceDrop={onPieceDrop}
            lastMoveUci={lastMoveUci}
            customArrows={customArrows}
            status={
              feedback?.kind === 'correct'
                ? 'correct'
                : feedback?.kind === 'wrong'
                ? 'incorrect'
                : null
            }
          />
          {wrongModalOpen && feedback?.kind === 'wrong' && (
            <div
              className="opening-trainer-wrong-modal"
              role="dialog"
              aria-modal="true"
              data-testid="opening-trainer-wrong-modal"
            >
              <div className="opening-trainer-wrong-modal__card">
                <h3>
                  {t(
                    'openingTrainer.session.wrongModal.title',
                    'Not in the repertoire',
                  )}
                </h3>
                <p>
                  {t(
                    'openingTrainer.session.wrongModal.hint',
                    'Try the move that matches your prepared line.',
                  )}
                </p>
                {feedback.expected.length > 0 && (
                  <div className="opening-trainer-wrong-modal__expected">
                    {t('openingTrainer.session.expected', 'Expected')}:{' '}
                    <b>{feedback.expected.map((m) => m.moveSan).join(', ')}</b>
                  </div>
                )}
                <div className="opening-trainer-wrong-modal__actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleRetryAfterWrong}
                    data-testid="opening-trainer-wrong-retry"
                  >
                    {t('openingTrainer.session.wrongModal.retry', 'Try again')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={handleGiveup}
                    data-testid="opening-trainer-wrong-giveup"
                  >
                    {t('openingTrainer.session.wrongModal.giveup', 'Show answer')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="opening-trainer-session__sidebar">
          {feedback?.kind === 'correct' && (
            <div className="opening-trainer-feedback opening-trainer-feedback--correct">
              ✓ {t('openingTrainer.session.correct', 'Correct')}
              {feedback.scoreDelta > 0 ? ` (+${feedback.scoreDelta})` : ''}
            </div>
          )}
          {feedback?.kind === 'wrong' && !wrongModalOpen && (
            <div
              className="opening-trainer-feedback opening-trainer-feedback--wrong"
              data-testid="opening-trainer-wrong"
            >
              ✗ {t('openingTrainer.session.wrong', 'Not in the repertoire')}
              {feedback.expected.length > 0 && (
                <div className="opening-trainer-feedback__expected">
                  {t('openingTrainer.session.expected', 'Expected')}:{' '}
                  {feedback.expected.map((m) => m.moveSan).join(', ')}
                </div>
              )}
            </div>
          )}
          {feedback?.kind === 'line-complete' && (
            <div className="opening-trainer-feedback opening-trainer-feedback--done">
              ✓ {t('openingTrainer.session.lineComplete', 'Line completed')}
            </div>
          )}
          {feedback?.kind === 'line-restart' && (
            <div
              className="opening-trainer-feedback opening-trainer-feedback--done"
              data-testid="opening-trainer-line-restart"
            >
              ↪{' '}
              {t(
                'openingTrainer.session.lineRestart',
                'Line done — switching to the next variation.',
              )}
            </div>
          )}
          {feedback?.kind === 'tree-complete' && (
            <div
              className="opening-trainer-feedback opening-trainer-feedback--done"
              data-testid="opening-trainer-tree-complete"
            >
              🏆{' '}
              {t(
                'openingTrainer.session.treeComplete',
                'Entire repertoire learned without errors.',
              )}
            </div>
          )}
          {feedback?.kind === 'hint' && (
            <div className="opening-trainer-feedback opening-trainer-feedback--hint">
              💡 {t('openingTrainer.session.hint', 'Hint')}: {feedback.moveSan}
            </div>
          )}

          <div className="opening-trainer-session__controls">
            <button
              type="button"
              className="btn"
              onClick={handleHint}
              disabled={submitting}
              data-testid="opening-trainer-hint"
              title={t(
                'openingTrainer.session.hintTooltip',
                'Highlight the best move on the board (half points).',
              )}
            >
              💡 {t('openingTrainer.session.hintBtn', 'Hint')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleUndo}
              disabled={submitting || session.movesPlayed === 0}
              data-testid="opening-trainer-undo"
            >
              ↶ {t('openingTrainer.session.undo', 'Undo')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleGiveup}
              disabled={submitting}
              data-testid="opening-trainer-giveup"
            >
              {t('openingTrainer.session.giveup', 'Show answer')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleFinish}
              disabled={finishing}
              data-testid="opening-trainer-finish"
            >
              {finishing
                ? t('openingTrainer.session.finishing', 'Finishing…')
                : t('openingTrainer.session.finish', 'Finish session')}
            </button>
          </div>

          {loadError && (
            <div className="error" data-testid="opening-trainer-session-error">
              {loadError}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
