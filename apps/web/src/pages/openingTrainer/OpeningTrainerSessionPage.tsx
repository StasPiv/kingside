/**
 * KS-3273 (ADR-077 §2.8 #4). Сессия тренировки — доска + бот + контролы.
 *
 * Flow:
 *  1. Mount — берём `session` + `initialBotMove` из location.state (если
 *     пришли через DetailPage.start). Если state пуст (refresh, прямая
 *     ссылка) — GET /opening-trainer/sessions/:sid и восстанавливаем
 *     `currentFen`.
 *  2. Если играем чёрными и `initialBotMove != null` — отрисуем сначала
 *     ход бота. У бэка currentFen УЖЕ после бот-хода, поэтому строим
 *     Chess из currentFen и проигрываем «анимацию» через короткую паузу
 *     (визуально показывает что бот сходил — UX). Источник истины fen —
 *     `session.currentFen`.
 *  3. onPieceDrop → POST /move. По дискриминатору `result`:
 *      - correct: обновляем fen, если botMove есть — анимируем после
 *        короткой паузы; обновляем session.
 *      - wrong: показываем popup с expected, fen не двигаем (бэк не применил).
 *      - line-complete: финиш линии, предлагаем «продолжить» (получить
 *        новую линию через POST /move невозможно — переходим на result-
 *        страницу через finish).
 *  4. Hint / Undo / Giveup / Finish — кнопки в боковой колонке.
 *
 * Запоминаем время показа позиции в `positionShownAtRef` → передаём в
 * `responseTimeMs` для fast-bonus и SRS (M2).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import { PuzzleBoard } from '../../components/PuzzleBoard';
import {
  isCorrectMove,
  isLineCompleteMove,
  isWrongMove,
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
  | { kind: 'hint'; moveSan: string }
  | null;

export function OpeningTrainerSessionPage() {
  const { t } = useTranslation();
  const { id, sid } = useParams<{ id: string; sid: string }>();
  const navigate = useNavigate();
  const location = useLocation();
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
  const positionShownAtRef = useRef<number>(Date.now());

  // Bootstrap — если пришли без state, грузим сессию.
  useEffect(() => {
    if (!sid) return;
    if (incoming?.session) {
      // ничего грузить не нужно
      return;
    }
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
      // Last-move highlight — берём последний UCI из currentPath, если есть.
      const last = session.currentPath[session.currentPath.length - 1];
      setLastMoveUci(last ?? null);
      positionShownAtRef.current = Date.now();
    } catch (e) {
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
    (newFen: string, botMove: { moveUci: string; newFen: string } | null) => {
      // Сразу показываем нашу позицию (newFen без бот-хода), потом через
      // паузу — после бот-хода. Без задержки игрок не увидит, что бот
      // сходил.
      try {
        const afterOurs = new Chess(newFen);
        setGame(afterOurs);
      } catch {
        // ignore — на следующем шаге доска перерисуется по getSession()
      }
      if (botMove) {
        setTimeout(() => {
          try {
            const afterBot = new Chess(botMove.newFen);
            setGame(afterBot);
            setLastMoveUci(botMove.moveUci);
            positionShownAtRef.current = Date.now();
          } catch {
            /* ignore */
          }
        }, 400);
      } else {
        positionShownAtRef.current = Date.now();
      }
    },
    [],
  );

  const handleMoveResponse = useCallback(
    (res: OpeningTrainerMoveResponse) => {
      setSession(res.session);
      if (isCorrectMove(res)) {
        setLastMoveUci(null);
        setFeedback({ kind: 'correct', scoreDelta: res.scoreDelta });
        applyServerResponseAfterCorrect(res.newFen, res.botMove);
      } else if (isWrongMove(res)) {
        setFeedback({ kind: 'wrong', expected: res.expectedMoves });
        // fen не двигаем — у game уже была попытка пользователя в локальном
        // стейте, откатим до currentFen из session:
        try {
          setGame(new Chess(res.session.currentFen));
        } catch {
          /* ignore */
        }
      } else if (isLineCompleteMove(res)) {
        setFeedback({ kind: 'line-complete' });
        try {
          setGame(new Chess(res.newFen));
        } catch {
          /* ignore */
        }
      }
    },
    [applyServerResponseAfterCorrect],
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
        setFeedback({ kind: 'wrong', expected: [] });
        setLoadError(msg);
        // Откатываем доску до серверного currentFen.
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
      // Auto-promotion в ферзя в M1 (popup не делаем — лимит scope).
      // Если ход — повышение, всегда промоутим в ферзя.
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
      void sendMove(uci);
      return true;
    },
    [game, submitting, session?.status, isPromotionMove, sendMove],
  );

  const handleHint = useCallback(async () => {
    if (!sid || submitting) return;
    setSubmitting(true);
    try {
      const res = await openingTrainerApi.hint(sid);
      setSession(res.session);
      setFeedback({ kind: 'hint', moveSan: res.hint.moveSan });
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
    try {
      const res = await openingTrainerApi.giveup(sid);
      setSession(res.session);
      setFeedback({ kind: 'wrong', expected: res.expectedMoves });
      try {
        if (res.botMove) {
          setGame(new Chess(res.botMove.newFen));
          setLastMoveUci(res.botMove.moveUci);
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
  }, [sid, submitting, t]);

  const handleFinish = useCallback(async () => {
    if (!sid || finishing) return;
    setFinishing(true);
    try {
      await openingTrainerApi.finish(sid);
      navigate(`/opening-trainer/${id}/session/${sid}/result`, { replace: true });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t('openingTrainer.errors.finishFailed', 'Finish failed');
      setLoadError(msg);
      setFinishing(false);
    }
  }, [sid, finishing, navigate, id, t]);

  const orientation: 'white' | 'black' = session?.side ?? 'white';
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

  return (
    <div className="opening-trainer-session" data-testid="opening-trainer-session">
      <header className="opening-trainer-session__header">
        <h1>{t('openingTrainer.session.title', 'Opening training')}</h1>
        <div className="opening-trainer-session__counters">
          <span data-testid="opening-trainer-score">
            {t('openingTrainer.session.score', 'Score')}: <b>{session.score}</b>
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
            enabled={boardEnabled && expectedSide}
            onPieceDrop={onPieceDrop}
            lastMoveUci={lastMoveUci}
            status={
              feedback?.kind === 'correct'
                ? 'correct'
                : feedback?.kind === 'wrong'
                ? 'incorrect'
                : null
            }
          />
        </div>

        <aside className="opening-trainer-session__sidebar">
          {feedback?.kind === 'correct' && (
            <div className="opening-trainer-feedback opening-trainer-feedback--correct">
              ✓ {t('openingTrainer.session.correct', 'Correct')}
              {feedback.scoreDelta > 0 ? ` (+${feedback.scoreDelta})` : ''}
            </div>
          )}
          {feedback?.kind === 'wrong' && (
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
