/**
 * KS-4277. Общий проигрыватель Opening Trainer: доска + sidebar +
 * counters + controls + feedback + wrong-modal. Источник данных
 * полностью инкапсулирован в `OpeningTrainerAdapter` (см.
 * `adapters/types.ts`).
 *
 * До KS-4277 эта же логика дублировалась в `OpeningTrainerDemoPage`
 * (550 строк) и `OpeningTrainerSessionPage` (708 строк). Сейчас обе
 * страницы — тонкие обёртки, создающие соответствующий адаптер и
 * передающие его сюда.
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { ApiError } from '../../ApiError';
import { PuzzleBoard } from '../../components/PuzzleBoard';
import { useSounds, soundEventFromSan } from '../../hooks/useSounds';
import {
  OPENING_TRAINER_SCORING,
} from '@kingside/shared';
import type {
  OpeningTrainerAdapter,
  OpeningTrainerCounters,
  OpeningTrainerExpectedMove,
  OpeningTrainerInitialState,
  OpeningTrainerOutcome,
} from './adapters/types';
import { LocalDemoNotFoundError } from './adapters/LocalDemoAdapter';

const BOT_DELAY_MS = 420;
const HINT_ARROW_COLOR = 'rgba(56, 189, 248, 0.75)';
const TREE_COMPLETE_FINISH_DELAY_MS = 1500;
// KS-4670. Пауза между показом финальной позиции линии и переходом
// на следующую — чтобы пользователь успел увидеть «вот линия
// завершилась». Совпадает по тайму с `TREE_COMPLETE_FINISH_DELAY_MS`.
const LINE_COMPLETE_ADVANCE_DELAY_MS = 1500;

type Feedback =
  | { kind: 'correct'; scoreDelta?: number }
  | { kind: 'wrong'; expected: OpeningTrainerExpectedMove[] }
  | { kind: 'line-complete' }
  | { kind: 'line-restart' }
  | { kind: 'tree-complete' }
  | { kind: 'hint'; moveSan: string }
  | null;

export interface OpeningTrainerPlayerProps {
  adapter: OpeningTrainerAdapter;
  /**
   * Слот заголовка. Получает заголовок/описание из адаптера. Для
   * `DemoPage` — back-link + h1; для `SessionPage` — заголовок «Opening
   * training».
   */
  renderHeader?: (state: OpeningTrainerInitialState) => ReactNode;
  /** Дополнительный блок под controls — например guest-CTA в Demo. */
  renderSidebarExtra?: () => ReactNode;
  /** Колбек на «надо уйти на /result». Страница навигирует через React Router. */
  onSessionFinished?: (resultRoute: string) => void;
  /** testid корневого контейнера. Для Demo — `opening-trainer-demo-page`. */
  rootTestId?: string;
}

function isPromotionAttempt(chess: Chess, from: string, to: string): boolean {
  const piece = chess.get(from as never);
  if (!piece || piece.type !== 'p') return false;
  const targetRank = to[1];
  return (
    (piece.color === 'w' && targetRank === '8') ||
    (piece.color === 'b' && targetRank === '1')
  );
}

function uciSquares(uci: string | null): { from: string; to: string } | null {
  if (!uci || uci.length < 4) return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

function streakStyle(streak: number): { color: string; bonus: boolean } {
  if (streak >= OPENING_TRAINER_SCORING.streakThreshold) {
    return { color: '#facc15', bonus: true };
  }
  if (streak >= 4) return { color: '#a78bfa', bonus: false };
  if (streak >= 3) return { color: '#38bdf8', bonus: false };
  if (streak >= 2) return { color: '#4ade80', bonus: false };
  return { color: '#9ca3af', bonus: false };
}

export function OpeningTrainerPlayer({
  adapter,
  renderHeader,
  renderSidebarExtra,
  onSessionFinished,
  rootTestId = 'opening-trainer-session',
}: OpeningTrainerPlayerProps) {
  const { t } = useTranslation();
  const { playSound } = useSounds();
  const caps = adapter.capabilities;

  const [initial, setInitial] = useState<OpeningTrainerInitialState | null>(
    null,
  );
  const [chess, setChess] = useState<Chess | null>(null);
  const [lastMoveUci, setLastMoveUci] = useState<string | null>(null);
  const [counters, setCounters] = useState<OpeningTrainerCounters>({
    score: 0,
    correctMoves: 0,
    wrongMoves: 0,
    hintsUsed: 0,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [submitting, setSubmitting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [wrongModalOpen, setWrongModalOpen] = useState(false);
  const [hintArrowUci, setHintArrowUci] = useState<string | null>(null);
  const positionShownAtRef = useRef<number>(Date.now());

  // 1. Initial load.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    adapter
      .loadInitial()
      .then((state) => {
        if (cancelled) return;
        setInitial(state);
        try {
          setChess(new Chess(state.currentFen));
          setLastMoveUci(state.lastMoveUci);
          setCounters(state.counters);
          positionShownAtRef.current = Date.now();
        } catch {
          setLoadError(
            t(
              'openingTrainer.errors.invalidFen',
              'Invalid position from server',
            ),
          );
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof LocalDemoNotFoundError) {
          setNotFound(true);
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        const msg =
          err instanceof ApiError
            ? err.message
            : t(
                'openingTrainer.errors.loadSessionFailed',
                'Failed to load session',
              );
        setLoadError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter, t]);

  // 2. Применить outcome — общий диспетчер для submitMove и giveup.
  const applyOutcome = useCallback(
    (outcome: OpeningTrainerOutcome) => {
      setHintArrowUci(null);
      setCounters(outcome.counters);
      switch (outcome.kind) {
        case 'correct': {
          try {
            setChess(new Chess(outcome.newFen));
          } catch {
            /* ignore */
          }
          setLastMoveUci(outcome.lastMoveUci ?? null);
          setFeedback({ kind: 'correct', scoreDelta: outcome.scoreDelta });
          playSound('puzzle-correct');
          if (outcome.botMove) {
            const bot = outcome.botMove;
            window.setTimeout(() => {
              try {
                setChess(new Chess(bot.newFen));
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
          break;
        }
        case 'wrong': {
          setFeedback({ kind: 'wrong', expected: outcome.expected });
          if (caps.showWrongModal) setWrongModalOpen(true);
          playSound('puzzle-incorrect');
          // Применить bot-move (если был — это `giveup` показал ответ).
          const applyReset = () => {
            try {
              if (outcome.botMove) {
                setChess(new Chess(outcome.botMove.newFen));
                setLastMoveUci(outcome.botMove.moveUci);
                playSound(soundEventFromSan(outcome.botMove.moveSan));
              } else {
                setChess(new Chess(outcome.newFen));
                if (outcome.lastMoveUci !== undefined) {
                  setLastMoveUci(outcome.lastMoveUci);
                }
              }
            } catch {
              /* ignore */
            }
            positionShownAtRef.current = Date.now();
          };
          if (outcome.resetDelayMs > 0) {
            window.setTimeout(applyReset, outcome.resetDelayMs);
          } else {
            applyReset();
          }
          break;
        }
        case 'line-complete': {
          setFeedback({ kind: 'line-complete' });
          playSound('game-end');
          try {
            setChess(new Chess(outcome.newFen));
          } catch {
            /* ignore */
          }
          setLastMoveUci(outcome.lastMoveUci ?? null);
          positionShownAtRef.current = Date.now();
          // KS-4670. До этого правки UI после `line-complete` зависал
          // на финальной позиции: `expectedMoves` пустой → попытка
          // `giveup` падала с «Nothing to giveup — current position
          // has no expected moves». Backend `line-complete` приходит
          // в редких краевых случаях (см. ADR/typedef); основной
          // flow — `line-restart`/`tree-complete`. Чтобы пользователь
          // не оставался один на один с тупиком, через паузу
          // дёргаем `advanceAfterLineComplete()` — адаптер обновит
          // снимок сессии и решит, перейти на следующую линию или
          // выйти на result.
          if (adapter.advanceAfterLineComplete) {
            window.setTimeout(() => {
              void adapter
                .advanceAfterLineComplete!()
                .then((advance) => {
                  if (advance.kind === 'finished') {
                    if (onSessionFinished) {
                      onSessionFinished(advance.resultRoute);
                    }
                    return;
                  }
                  const next = advance.state;
                  setInitial(next);
                  try {
                    setChess(new Chess(next.currentFen));
                  } catch {
                    /* ignore */
                  }
                  setLastMoveUci(next.lastMoveUci);
                  setCounters(next.counters);
                  setFeedback(null);
                  positionShownAtRef.current = Date.now();
                })
                .catch(() => {
                  /* silent — оставляем пользователя в текущем
                     состоянии, кнопки «Откатить»/«Завершить» рабочие */
                });
            }, LINE_COMPLETE_ADVANCE_DELAY_MS);
          }
          break;
        }
        case 'line-restart': {
          setFeedback({ kind: 'line-restart' });
          playSound('game-start');
          try {
            setChess(new Chess(outcome.newFen));
          } catch {
            /* ignore */
          }
          setLastMoveUci(outcome.lastMoveUci ?? null);
          if (outcome.botMove) {
            const bot = outcome.botMove;
            window.setTimeout(() => {
              try {
                setChess(new Chess(bot.newFen));
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
          break;
        }
        case 'tree-complete': {
          setFeedback({ kind: 'tree-complete' });
          playSound('puzzle-gameover');
          try {
            setChess(new Chess(outcome.newFen));
          } catch {
            /* ignore */
          }
          setLastMoveUci(outcome.lastMoveUci ?? null);
          // KS-3277: бэк уже выставил session.status='finished'.
          // Не зовём adapter.finishSession() — оно вернёт 409.
          // Просто переходим на result после короткой паузы.
          if (onSessionFinished) {
            const route = outcome.resultRoute;
            window.setTimeout(
              () => onSessionFinished(route),
              TREE_COMPLETE_FINISH_DELAY_MS,
            );
          }
          break;
        }
      }
    },
    [caps.showWrongModal, playSound, onSessionFinished],
  );

  // 3. Onpiecedrop.
  const onPieceDrop = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      sourceSquare: string;
      targetSquare: string | null;
    }): boolean => {
      if (!targetSquare || !chess || submitting || wrongModalOpen) return false;
      if (!initial) return false;
      const side = initial.side;
      const turn: 'white' | 'black' = chess.turn() === 'w' ? 'white' : 'black';
      if (turn !== side) return false;
      const promotion = isPromotionAttempt(chess, sourceSquare, targetSquare)
        ? 'q'
        : undefined;
      const test = new Chess(chess.fen());
      const moved = test.move({
        from: sourceSquare,
        to: targetSquare,
        promotion,
      });
      if (!moved) return false;
      // KS-3282: визуально показываем свой ход — но только если адаптер
      // вернёт wrong с resetDelayMs > 0 (Demo). Сервер сразу откатит
      // через outcome.newFen=session.currentFen.
      setChess(test);
      const uci = sourceSquare + targetSquare + (promotion ?? '');
      setLastMoveUci(uci);
      playSound(soundEventFromSan(moved.san));
      const positionShownAtMs = positionShownAtRef.current;
      setSubmitting(true);
      setFeedback(null);
      adapter
        .submitMove({ moveUci: uci, positionShownAtMs })
        .then((outcome) => applyOutcome(outcome))
        .catch((err: unknown) => {
          const msg =
            err instanceof ApiError
              ? err.message
              : t('openingTrainer.errors.moveFailed', 'Move failed');
          setLoadError(msg);
          // Откатить доску в текущий валидный FEN.
          if (initial?.currentFen && chess) {
            try {
              setChess(new Chess(chess.fen() === test.fen() ? chess.fen() : chess.fen()));
            } catch {
              /* ignore */
            }
          }
        })
        .finally(() => setSubmitting(false));
      return true;
    },
    [adapter, applyOutcome, chess, initial, playSound, submitting, t, wrongModalOpen],
  );

  // 4. Контролы.
  const handleHint = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const hint = await adapter.requestHint();
      setCounters(hint.counters);
      if (!hint.moveUci) {
        // Демо: подсказывать нечего.
        return;
      }
      setFeedback({ kind: 'hint', moveSan: hint.moveSan });
      if (caps.showHintArrow) {
        setHintArrowUci(hint.moveUci);
      }
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t('openingTrainer.errors.hintFailed', 'Hint failed');
      setLoadError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [adapter, caps.showHintArrow, submitting, t]);

  const handleRestartLine = useCallback(async () => {
    if (!adapter.restartLine) return;
    try {
      const next = await adapter.restartLine();
      setInitial(next);
      setChess(new Chess(next.currentFen));
      setLastMoveUci(next.lastMoveUci);
      setCounters(next.counters);
      setFeedback(null);
      positionShownAtRef.current = Date.now();
    } catch {
      /* ignore */
    }
  }, [adapter]);

  const handleResetProgress = useCallback(async () => {
    if (!adapter.resetProgress) return;
    try {
      const next = await adapter.resetProgress();
      setInitial(next);
      setChess(new Chess(next.currentFen));
      setLastMoveUci(next.lastMoveUci);
      setCounters(next.counters);
      setFeedback(null);
      positionShownAtRef.current = Date.now();
    } catch {
      /* ignore */
    }
  }, [adapter]);

  const handleUndo = useCallback(async () => {
    if (!adapter.undoLastMove || submitting) return;
    setSubmitting(true);
    setFeedback(null);
    setHintArrowUci(null);
    try {
      const next = await adapter.undoLastMove();
      setChess(new Chess(next.currentFen));
      setLastMoveUci(next.lastMoveUci);
      setCounters(next.counters);
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
  }, [adapter, submitting, t]);

  const handleGiveup = useCallback(async () => {
    if (!adapter.giveup || submitting) return;
    setSubmitting(true);
    setWrongModalOpen(false);
    try {
      const outcome = await adapter.giveup();
      applyOutcome(outcome);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t('openingTrainer.errors.giveupFailed', 'Giveup failed');
      setLoadError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [adapter, applyOutcome, submitting, t]);

  const handleFinish = useCallback(async () => {
    if (!adapter.finishSession || finishing) return;
    setFinishing(true);
    try {
      const { resultRoute } = await adapter.finishSession();
      onSessionFinished?.(resultRoute);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t('openingTrainer.errors.finishFailed', 'Finish failed');
      setLoadError(msg);
      setFinishing(false);
    }
  }, [adapter, finishing, onSessionFinished, t]);

  const handleRetryAfterWrong = useCallback(() => {
    setWrongModalOpen(false);
    setFeedback(null);
  }, []);

  // 5. Деривативы для рендера.
  const customArrows = useMemo(() => {
    const sq = uciSquares(hintArrowUci);
    if (!sq) return undefined;
    return [
      { startSquare: sq.from, endSquare: sq.to, color: HINT_ARROW_COLOR },
    ];
  }, [hintArrowUci]);

  const orientation: 'white' | 'black' = initial?.side ?? 'white';

  const boardEnabled = useMemo(() => {
    if (!chess || submitting || wrongModalOpen) return false;
    if (feedback?.kind === 'line-complete') return false;
    if (feedback?.kind === 'tree-complete') return false;
    if (!initial) return false;
    const turn: 'white' | 'black' = chess.turn() === 'w' ? 'white' : 'black';
    if (turn !== initial.side) return false;
    return true;
  }, [chess, feedback, initial, submitting, wrongModalOpen]);

  // 6. Loading / error.
  if (loading) {
    return (
      <div className="loading" data-testid={`${rootTestId}-loading`}>
        {t('common.loading')}
      </div>
    );
  }
  if (notFound) {
    return (
      <section className="empty-state" data-testid={`${rootTestId}-empty`}>
        <p>
          {t(
            'openingTrainer.demo.empty',
            'Demo repertoires are coming soon — check back later.',
          )}
        </p>
      </section>
    );
  }
  if (loadError && !chess) {
    return (
      <div className="error" data-testid={`${rootTestId}-error`}>
        {loadError}
      </div>
    );
  }
  if (!initial || !chess) {
    return <div className="loading">{t('common.loading')}</div>;
  }

  // 7. Render.
  const counterStreak = counters.streak ?? 0;
  const streakColors = streakStyle(counterStreak);

  return (
    <div className="opening-trainer-session" data-testid={rootTestId}>
      {renderHeader ? (
        renderHeader(initial)
      ) : (
        <header className="opening-trainer-session__header">
          <h1>{t('openingTrainer.session.title', 'Opening training')}</h1>
        </header>
      )}

      <div className="opening-trainer-session__counters">
        <span data-testid="opening-trainer-score">
          {t('openingTrainer.session.score', 'Score')}:{' '}
          <b>{counters.score}</b>
        </span>
        {caps.showStreak && (
          <span
            className="opening-trainer-streak"
            data-testid="opening-trainer-streak"
            data-bonus={streakColors.bonus ? 'true' : 'false'}
            style={{ color: streakColors.color }}
          >
            🔥 <b>{counterStreak}</b>
            {streakColors.bonus && (
              <span
                className="opening-trainer-streak__badge"
                data-testid="opening-trainer-streak-bonus"
              >
                ×{OPENING_TRAINER_SCORING.streakMultiplier}
              </span>
            )}
          </span>
        )}
        <span>
          ✓ <b>{counters.correctMoves}</b>
        </span>
        <span>
          ✗ <b>{counters.wrongMoves}</b>
        </span>
        <span>
          💡 <b>{counters.hintsUsed}</b>
        </span>
      </div>

      <div className="opening-trainer-session__body">
        <div className="opening-trainer-session__board">
          <PuzzleBoard
            game={chess}
            boardOrientation={orientation}
            enabled={boardEnabled}
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
          {caps.showWrongModal && wrongModalOpen && feedback?.kind === 'wrong' && (
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
                    <b>
                      {feedback.expected.map((m) => m.moveSan).join(', ')}
                    </b>
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
                  {caps.showGiveupButton && (
                    <button
                      type="button"
                      className="btn"
                      onClick={handleGiveup}
                      data-testid="opening-trainer-wrong-giveup"
                    >
                      {t(
                        'openingTrainer.session.wrongModal.giveup',
                        'Show answer',
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="opening-trainer-session__sidebar">
          {feedback?.kind === 'correct' && (
            <div className="opening-trainer-feedback opening-trainer-feedback--correct">
              ✓ {t('openingTrainer.session.correct', 'Correct')}
              {feedback.scoreDelta && feedback.scoreDelta > 0
                ? ` (+${feedback.scoreDelta})`
                : ''}
            </div>
          )}
          {feedback?.kind === 'wrong' && !wrongModalOpen && (
            <div
              className="opening-trainer-feedback opening-trainer-feedback--wrong"
              data-testid="opening-trainer-wrong"
            >
              ✗{' '}
              {t('openingTrainer.session.wrong', 'Not in the repertoire')}
              {feedback.expected.length > 0 && (
                <div className="opening-trainer-feedback__expected">
                  {t('openingTrainer.session.expected', 'Expected')}:{' '}
                  {feedback.expected.map((m) => m.moveSan).join(', ')}
                </div>
              )}
            </div>
          )}
          {feedback?.kind === 'line-complete' && (
            <div
              className="opening-trainer-feedback opening-trainer-feedback--done"
              data-testid="opening-trainer-line-complete"
            >
              🏁{' '}
              {t('openingTrainer.session.lineComplete', 'Line completed')}
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
            >
              💡 {t('openingTrainer.session.hintBtn', 'Hint')}
            </button>
            {caps.showUndoButton && (
              <button
                type="button"
                className="btn"
                onClick={handleUndo}
                disabled={submitting || (counters.movesPlayed ?? 0) === 0}
                data-testid="opening-trainer-undo"
              >
                ↶ {t('openingTrainer.session.undo', 'Undo')}
              </button>
            )}
            {caps.showGiveupButton && (
              <button
                type="button"
                className="btn"
                onClick={handleGiveup}
                disabled={submitting}
                data-testid="opening-trainer-giveup"
              >
                {t('openingTrainer.session.giveup', 'Show answer')}
              </button>
            )}
            {caps.showRestartLineButton && (
              <button
                type="button"
                className="btn"
                onClick={handleRestartLine}
                data-testid="opening-trainer-demo-restart"
              >
                ↻ {t('openingTrainer.demo.restart', 'Restart line')}
              </button>
            )}
            {caps.showResetProgressButton && (
              <button
                type="button"
                className="btn"
                onClick={handleResetProgress}
                data-testid="opening-trainer-demo-reset"
              >
                {t('openingTrainer.demo.resetProgress', 'Reset progress')}
              </button>
            )}
            {caps.showFinishButton && (
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
            )}
          </div>

          {renderSidebarExtra?.()}

          {loadError && (
            <div className="error" data-testid={`${rootTestId}-error`}>
              {loadError}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
