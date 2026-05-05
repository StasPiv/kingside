import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Square as ChessSquare } from 'chess.js';
import type {
  AnswerData,
  TacticDrillDto,
  TacticDrillSprintStartResponse,
  TacticDrillSprintSubmitResponse,
} from '@kingside/shared';

import { api } from '../api';
import {
  DrillBoard,
  DrillCountAttackersButtons,
  DrillFeedbackOverlay,
  DrillInstructions,
  SprintTimer,
  type DrillCountValue,
} from '../components/drills';
// KS-2425: sprint-mode не использовал DrillRunner и потому не получил
// звуки KS-2423. Подключаем тот же useDrillSounds (drill-mute уважается).
import { useDrillSounds, resolveMoveSound } from '../hooks/useDrillSounds';

/**
 * KS-2241 (ADR-035 §5.5, Drills E4) — gameplay sprint-режима.
 *
 * Получает session из `location.state.session` (отдан SetupPage).
 * Если state потерян (например, прямой URL `/drills/sprint/play`) —
 * редирект на setup, отдельный /start не делаем (сессии без явного
 * выбора пользователя нет).
 *
 * Flow:
 *   - render первого drill из session.drill;
 *   - таймер общего времени отсчитывает session.durationMs от
 *     session.startedAt — независимо от per-drill timing;
 *   - submit ответа → POST /sprint/submit с sessionId+timeMs (per-drill);
 *     показываем короткий feedback (~700ms) и грузим resp.next либо
 *     заканчиваем по resp.final;
 *   - таймер сел в 0 → POST /sprint/finish, возвращаем final;
 *   - в обоих финишных случаях — navigate('/drills/sprint/results').
 *
 * Прогресс/score фронтового state:
 *   - `score` инкрементируется по resp.attempt.solved;
 *   - `attempted` — по каждому submit'у;
 *   - `accuracy` для UI — score / attempted, точная — в final от backend.
 */

interface SessionState {
  session: TacticDrillSprintStartResponse;
}

interface FinalSummary {
  scoreId: string;
  score: number;
  accuracy: number;
  avgPrecision: number;
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function DrillSprintPlayPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // KS-2425.
  const { play: playDrillSound } = useDrillSounds();

  const sessionFromState = (location.state as SessionState | null)?.session ?? null;

  // Если открыли страницу напрямую — нет session, редиректим на setup.
  useEffect(() => {
    if (!sessionFromState) {
      navigate('/drills/sprint', { replace: true });
    }
  }, [sessionFromState, navigate]);

  const [drill, setDrill] = useState<TacticDrillDto | null>(
    sessionFromState?.drill ?? null,
  );
  const [score, setScore] = useState(0);
  const [attempted, setAttempted] = useState(0);
  const [feedback, setFeedback] = useState<{
    solved: boolean;
    correctAnswer: AnswerData;
  } | null>(null);
  const [pickedSquares, setPickedSquares] = useState<string[]>([]);
  const [pickedFrom, setPickedFrom] = useState<string | null>(null);

  const sessionId = sessionFromState?.sessionId ?? null;
  const startedAtMs = useMemo(
    () => (sessionFromState ? new Date(sessionFromState.startedAt).getTime() : 0),
    [sessionFromState],
  );
  const durationMs = sessionFromState?.durationMs ?? 0;

  const drillStartRef = useRef<number>(Date.now());
  const finishedRef = useRef(false);

  // KS-2428: latest-ref pattern для drill / feedback / pickedFrom.
  // Callback'и handleSquareClick/handlePieceDrop/handlePiecePickup
  // читают актуальные значения через ref'ы — сами callback'и при этом
  // имеют стабильные ссылки. Это позволяет React.memo на DrillBoard
  // эффективно срабатывать: при ререндере PlayPage (например, на ответ
  // сервера / клик пользователя) ссылки на onSquareClick/onPieceDrop/
  // onPiecePickup не меняются → DrillBoard не переходит к useFastDrag /
  // useContainerWidth заново.
  const drillRef = useRef(drill);
  drillRef.current = drill;
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const pickedFromRef = useRef(pickedFrom);
  pickedFromRef.current = pickedFrom;

  const goToResults = useCallback(
    (final: FinalSummary | null, ended: 'submitted' | 'expired') => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      // KS-2251: пробрасываем durationLabel/setLabel в state — нужны
      // ResultsPage'у для подписи под share-картинкой. Если sprint
      // session не отдала эти поля (нет в sessionFromState), оставим
      // undefined — ResultsPage подставит дефолты.
      const durMin = Math.round((sessionFromState?.durationMs ?? 180000) / 60000);
      navigate('/drills/sprint/results', {
        replace: true,
        state: {
          final,
          ended,
          durationLabel: `${durMin} min`,
        },
      });
    },
    [navigate, sessionFromState?.durationMs],
  );

  // KS-2428: таймер вынесен в `<SprintTimer>` (memo). Тики 4 раза в
  // секунду больше не дёргают весь PlayPage — родитель ререндерится
  // только на ответ сервера / клик пользователя. handleTimerExpire
  // вызывается ровно один раз когда таймер сел в 0.
  const handleTimerExpire = useCallback(() => {
    if (finishedRef.current) return;
    // Время вышло — POST /finish для финального счёта.
    api
      .post<FinalSummary>('/tactic-drill/sprint/finish', { sessionId })
      .then((resp) => goToResults(resp, 'expired'))
      .catch(() => goToResults(null, 'expired'));
  }, [sessionId, goToResults]);

  const submitAnswer = useCallback(
    async (userAnswer: AnswerData) => {
      // KS-2428: читаем актуальные drill/feedback из ref, чтобы
      // submitAnswer оставался стабильной ссылкой между ререндерами.
      const drill = drillRef.current;
      const feedback = feedbackRef.current;
      if (!drill || !sessionId || feedback || finishedRef.current) return;
      const timeMs = Date.now() - drillStartRef.current;
      // KS-2425: озвучиваем сам факт хода/ответа — тот же контракт,
      // что в DrillRunner (KS-2423).
      if (userAnswer.shape === 'move') {
        playDrillSound(resolveMoveSound(drill.fen, userAnswer.from, userAnswer.to));
      } else if (userAnswer.shape === 'square' || userAnswer.shape === 'squares') {
        playDrillSound('move');
      }
      try {
        const resp = await api.post<TacticDrillSprintSubmitResponse>(
          '/tactic-drill/sprint/submit',
          {
            drillId: drill.id,
            userAnswer,
            timeMs,
            mode: 'sprint',
            sessionId,
          },
        );
        setAttempted((n) => n + 1);
        if (resp.attempt.solved) setScore((s) => s + 1);
        setFeedback({
          solved: resp.attempt.solved,
          correctAnswer: resp.attempt.correctAnswer,
        });
        // KS-2425: вердикт правильности.
        playDrillSound(resp.attempt.solved ? 'puzzle-correct' : 'puzzle-incorrect');
        // Через 700ms — показать следующий drill или уйти в results.
        setTimeout(() => {
          if (finishedRef.current) return;
          if (resp.next) {
            setDrill(resp.next);
            setFeedback(null);
            setPickedSquares([]);
            setPickedFrom(null);
            drillStartRef.current = Date.now();
          } else if (resp.final) {
            goToResults(resp.final, 'submitted');
          } else {
            goToResults(null, 'submitted');
          }
        }, 700);
      } catch {
        // На сетевой ошибке submit — просто очищаем feedback, юзер
        // повторит ответ. /finish дёрнется по timer expiry.
        setFeedback(null);
      }
    },
    [sessionId, goToResults, playDrillSound],
  );

  const handleSquareClick = useCallback(
    (sq: ChessSquare) => {
      // KS-2428: latest-ref для drill/feedback/pickedFrom — стабильная
      // ссылка callback'а.
      const drill = drillRef.current;
      const feedback = feedbackRef.current;
      const pickedFrom = pickedFromRef.current;
      if (!drill || feedback) return;
      switch (drill.answerShape) {
        case 'square':
          void submitAnswer({ shape: 'square', square: sq });
          break;
        case 'squares':
          playDrillSound('select');
          setPickedSquares((prev) =>
            prev.includes(sq) ? prev.filter((x) => x !== sq) : [...prev, sq],
          );
          break;
        case 'move':
          if (pickedFrom === null) {
            playDrillSound('select');
            setPickedFrom(sq);
          } else if (pickedFrom === sq) {
            playDrillSound('select');
            setPickedFrom(null);
          } else {
            void submitAnswer({ shape: 'move', from: pickedFrom, to: sq });
            setPickedFrom(null);
          }
          break;
        case 'number':
          break;
      }
    },
    [submitAnswer, playDrillSound],
  );

  const handleNumberPick = useCallback(
    (n: DrillCountValue) => {
      void submitAnswer({ shape: 'number', value: n });
    },
    [submitAnswer],
  );

  const handleSubmitSquares = useCallback(() => {
    if (pickedSquares.length === 0) return;
    void submitAnswer({ shape: 'squares', squares: pickedSquares });
  }, [pickedSquares, submitAnswer]);

  // KS-2426: drag-drop ввод хода для shape='move' — по образцу
  // DrillRunner. Возвращаем boolean для useFastDrag (true = принят,
  // false = snap-back). При accepted — submit идёт асинхронно через
  // submitAnswer, который сам играет move/capture/check/castle и
  // verdict.
  const handlePieceDrop = useCallback(
    (args: { sourceSquare: string; targetSquare: string | null }): boolean => {
      const drill = drillRef.current;
      const feedback = feedbackRef.current;
      if (!drill || feedback || finishedRef.current) return false;
      if (drill.answerShape !== 'move') return false;
      const { sourceSquare, targetSquare } = args;
      if (!sourceSquare || !targetSquare) return false;
      if (sourceSquare === targetSquare) return false;
      // Сбрасываем click-state, чтобы не было конфликта с click-flow.
      setPickedFrom(null);
      void submitAnswer({
        shape: 'move',
        from: sourceSquare,
        to: targetSquare,
      });
      return true;
    },
    [submitAnswer],
  );

  // KS-2426: pickup-звук на drag (через useFastDrag → DrillBoard).
  // Click-pickup уже озвучивается в handleSquareClick.
  const handlePiecePickup = useCallback(() => {
    playDrillSound('select');
  }, [playDrillSound]);

  const highlightedSquares = useMemo<string[]>(() => {
    if (!drill) return [];
    if (feedback) {
      const c = feedback.correctAnswer;
      if (c.shape === 'square') return [c.square];
      if (c.shape === 'squares') return c.squares;
      if (c.shape === 'move') return [c.from, c.to];
    }
    if (drill.answerShape === 'squares') return pickedSquares;
    if (drill.answerShape === 'move' && pickedFrom) return [pickedFrom];
    if (drill.answerShape === 'number' && drill.meta?.highlightedSquare) {
      return [drill.meta.highlightedSquare];
    }
    return [];
  }, [drill, feedback, pickedSquares, pickedFrom]);

  const instructionText = useMemo(() => {
    if (!drill) return '';
    if (feedback) {
      return feedback.solved
        ? t('drills.feedback.correct', 'Correct!')
        : t('drills.feedback.incorrect', 'Not quite');
    }
    return t(`drills.instructions.${kebabToCamel(drill.drillType)}`);
  }, [drill, feedback, t]);

  const instructionTone =
    feedback === null ? 'info' : feedback.solved ? 'success' : 'error';

  // KS-2428: мемоизируем overlay-элемент, иначе на каждом ререндере
  // PlayPage создаётся новый JSX-объект — DrillBoard.memo бы не пускал
  // его как стабильный prop.
  const boardOverlay = useMemo(
    () =>
      feedback ? (
        <DrillFeedbackOverlay result={feedback.solved ? 'correct' : 'incorrect'} />
      ) : null,
    [feedback],
  );

  const boardOrientation = drill?.sideToMove === 'b' ? 'black' : 'white';
  const sprintOnPieceDrop =
    drill?.answerShape === 'move' ? handlePieceDrop : undefined;
  const sprintOnPiecePickup =
    drill?.answerShape === 'move' ? handlePiecePickup : undefined;

  if (!sessionFromState || !drill) {
    return (
      <div
        className="drill-sprint-play drill-sprint-play--loading"
        data-testid="drill-sprint-play"
        data-state="loading"
      >
        <p>{t('drills.sprint.play.loading', 'Loading first drill…')}</p>
      </div>
    );
  }

  return (
    <div
      className="drill-sprint-play"
      data-testid="drill-sprint-play"
      data-state={feedback ? 'feedback' : 'idle'}
      data-shape={drill.answerShape}
    >
      <header className="drill-sprint-play__header">
        <div
          className="drill-sprint-play__score"
          data-testid="drill-sprint-play-score"
          data-score={score}
          data-attempted={attempted}
        >
          {t('drills.sprint.play.score', 'Score')}: {score} / {attempted}
        </div>
        <SprintTimer
          durationMs={durationMs}
          startedAtMs={startedAtMs}
          label={t('drills.sprint.play.timeLeft', 'Time left')}
          onExpire={handleTimerExpire}
        />
      </header>

      <DrillInstructions tone={instructionTone}>{instructionText}</DrillInstructions>

      {drill.sideToMove && (
        <div
          className="drill-sprint-play__side"
          data-testid="drill-sprint-play-side"
          data-side={drill.sideToMove}
        >
          {drill.sideToMove === 'w'
            ? t('drills.side.whiteToMove', 'White to move')
            : t('drills.side.blackToMove', 'Black to move')}
        </div>
      )}

      <DrillBoard
        position={drill.fen}
        boardOrientation={boardOrientation}
        highlightedSquares={highlightedSquares}
        onSquareClick={handleSquareClick}
        // KS-2426: drag-drop ввод для shape='move' (как в DrillRunner).
        onPieceDrop={sprintOnPieceDrop}
        onPiecePickup={sprintOnPiecePickup}
        overlay={boardOverlay}
      />

      <div className="drill-sprint-play__controls" data-testid="drill-sprint-play-controls">
        {drill.answerShape === 'number' && (
          <DrillCountAttackersButtons
            disabled={feedback !== null}
            onSelect={handleNumberPick}
          />
        )}
        {drill.answerShape === 'squares' && (
          <>
            <span
              className="drill-sprint-play__squares-counter"
              data-testid="drill-sprint-play-squares-counter"
            >
              {pickedSquares.length}
              {drill.meta?.expectedCount !== undefined
                ? ` / ${drill.meta.expectedCount}`
                : ''}
            </span>
            <button
              type="button"
              className="drill-sprint-play__submit"
              data-testid="drill-sprint-play-submit"
              disabled={feedback !== null || pickedSquares.length === 0}
              onClick={handleSubmitSquares}
            >
              {t('drills.buttons.submit', 'Submit')}
            </button>
          </>
        )}
        {drill.answerShape === 'move' && pickedFrom && (
          <span
            className="drill-sprint-play__move-hint"
            data-testid="drill-sprint-play-move-hint"
          >
            {pickedFrom} → ?
          </span>
        )}
      </div>
    </div>
  );
}
