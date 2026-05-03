import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Square as ChessSquare } from 'chess.js';
import type {
  AnswerData,
  AnswerShape,
  TacticDrillType,
  TacticDrillDto,
  TacticDrillAttemptRequest,
  TacticDrillAttemptResponse,
} from '@kingside/shared';

import { api } from '../api';
import {
  DrillBoard,
  DrillCountAttackersButtons,
  DrillFeedbackOverlay,
  DrillInstructions,
  type DrillCountValue,
} from '../components/drills';

/**
 * KS-2233 (ADR-035 §5, E3) — основная страница drill `/drills/:type`.
 *
 * Flow:
 *   loading → idle (пользователь отвечает) → submitting → feedback → loading
 *
 * Поддерживает 4 answer-shape:
 *   • `square` — один клик по клетке отправляет ответ.
 *   • `squares` — клики накапливаются (re-click снимает выделение),
 *     кнопка «Ответить» отправляет финальный список.
 *   • `number` — `<DrillCountAttackersButtons>` (1..4) отправляет на клик.
 *   • `move` — два клика: from → to. Промоушены отбрасываются
 *     генератором (KS-2225 §3), поэтому promotion НЕ собираем.
 *
 * Прогресс-бар сессии — count solved / count attempted (локальный state).
 * Таймер per-drill стартует при рендере drill'а, останавливается на
 * submit'е и отправляется как `timeMs` в `/attempt`.
 *
 * Mobile-portrait: основной input — клик по клетке (`DrillBoard.onSquareClick`).
 * `allowDragging=false` (по умолчанию в DrillBoard) — drag не нужен.
 *
 * # Контракт DOM
 *
 *   <div class="drill-page" data-testid="drill-page" data-type="<type>"
 *        data-state="loading|idle|submitting|feedback|error">
 *     <header class="drill-page__header">
 *       <Link class="drill-page__back" to="/drills">…</Link>
 *       <div class="drill-page__progress">…</div>
 *       <div class="drill-page__timer">…</div>
 *     </header>
 *     <DrillInstructions tone="info|success|error">…</DrillInstructions>
 *     <DrillBoard … overlay={<DrillFeedbackOverlay … />} />
 *     <div class="drill-page__answer-controls">…</div>
 *     <button class="drill-page__submit-btn">…</button>     // squares/move
 *     <button class="drill-page__next-btn">…</button>       // во время feedback
 *   </div>
 */

type PageState = 'loading' | 'idle' | 'submitting' | 'feedback' | 'error';

interface SessionStats {
  attempted: number;
  solved: number;
}

const ALL_TYPES: TacticDrillType[] = [
  'find-hanging-piece',
  'find-loose-piece',
  'find-pin',
  'find-fork',
  'find-mate-in-one-square',
  'count-attackers',
  'find-all-checks',
  'find-undefended-attack',
];

function isValidType(s: string | undefined): s is TacticDrillType {
  return !!s && (ALL_TYPES as string[]).includes(s);
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function DrillPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { type } = useParams<{ type: string }>();

  // Невалидный type в URL → редирект в лобби. Нельзя открыть drill для
  // несуществующего drill-type.
  useEffect(() => {
    if (!isValidType(type)) {
      navigate('/drills', { replace: true });
    }
  }, [type, navigate]);

  const drillType = isValidType(type) ? type : null;

  const [state, setState] = useState<PageState>('loading');
  const [drill, setDrill] = useState<TacticDrillDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SessionStats>({ attempted: 0, solved: 0 });
  const [feedback, setFeedback] = useState<{
    solved: boolean;
    correctAnswer: AnswerData;
  } | null>(null);

  // Накапливаемые ответы (для shape='squares' / 'move').
  const [pickedSquares, setPickedSquares] = useState<string[]>([]);
  const [pickedFrom, setPickedFrom] = useState<string | null>(null);

  // Таймер per-drill.
  const startedAtRef = useRef<number>(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  // Загрузка следующего drill'а.
  const fetchNext = useCallback(async () => {
    if (!drillType) return;
    setState('loading');
    setError(null);
    setFeedback(null);
    setPickedSquares([]);
    setPickedFrom(null);
    setElapsedMs(0);
    try {
      const next = await api.get<TacticDrillDto>(
        `/tactic-drill/next?type=${encodeURIComponent(drillType)}`,
      );
      setDrill(next);
      startedAtRef.current = Date.now();
      setState('idle');
    } catch {
      setError('loadFailed');
      setState('error');
    }
  }, [drillType]);

  useEffect(() => {
    if (drillType) void fetchNext();
  }, [drillType, fetchNext]);

  // Тикающий таймер — обновление раз в 250 мс пока state='idle'.
  useEffect(() => {
    if (state !== 'idle') return;
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 250);
    return () => clearInterval(id);
  }, [state]);

  // Submit ответа.
  const submitAnswer = useCallback(
    async (userAnswer: AnswerData) => {
      if (!drill || state !== 'idle') return;
      const timeMs = Date.now() - startedAtRef.current;
      setState('submitting');
      try {
        const req: TacticDrillAttemptRequest = {
          drillId: drill.id,
          userAnswer,
          timeMs,
          mode: 'drill',
        };
        const resp = await api.post<TacticDrillAttemptResponse>(
          '/tactic-drill/attempt',
          req,
        );
        setStats((s) => ({
          attempted: s.attempted + 1,
          solved: s.solved + (resp.solved ? 1 : 0),
        }));
        setFeedback({
          solved: resp.solved,
          correctAnswer: resp.correctAnswer,
        });
        setState('feedback');
      } catch {
        setError('submitFailed');
        setState('error');
      }
    },
    [drill, state],
  );

  // Click по клетке — поведение зависит от answerShape.
  const handleSquareClick = useCallback(
    (sq: ChessSquare) => {
      if (state !== 'idle' || !drill) return;
      switch (drill.answerShape) {
        case 'square':
          void submitAnswer({ shape: 'square', square: sq });
          break;
        case 'squares':
          // Toggle: уже в списке → убираем; нет → добавляем.
          setPickedSquares((prev) =>
            prev.includes(sq) ? prev.filter((x) => x !== sq) : [...prev, sq],
          );
          break;
        case 'move':
          if (pickedFrom === null) {
            setPickedFrom(sq);
          } else if (pickedFrom === sq) {
            // Повторный клик по from — снять выбор.
            setPickedFrom(null);
          } else {
            void submitAnswer({ shape: 'move', from: pickedFrom, to: sq });
            setPickedFrom(null);
          }
          break;
        case 'number':
          // Клик по доске игнорируется — для number-shape ввод через
          // <DrillCountAttackersButtons>.
          break;
      }
    },
    [drill, pickedFrom, state, submitAnswer],
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

  // Подсветка клеток на доске:
  //  - feedback === null:
  //      • shape='squares' → подсвечиваем pickedSquares (выбор пользователя)
  //      • shape='move' → подсвечиваем pickedFrom
  //      • shape='number' → meta.highlightedSquare (целевая клетка)
  //  - feedback !== null → правильные клетки из correctAnswer.
  const highlightedSquares = useMemo<string[]>(() => {
    if (!drill) return [];
    if (feedback) {
      const c = feedback.correctAnswer;
      if (c.shape === 'square') return [c.square];
      if (c.shape === 'squares') return c.squares;
      if (c.shape === 'move') return [c.from, c.to];
      return drill.meta?.highlightedSquare ? [drill.meta.highlightedSquare] : [];
    }
    if (drill.answerShape === 'squares') return pickedSquares;
    if (drill.answerShape === 'move' && pickedFrom) return [pickedFrom];
    if (drill.answerShape === 'number' && drill.meta?.highlightedSquare) {
      return [drill.meta.highlightedSquare];
    }
    return [];
  }, [drill, feedback, pickedSquares, pickedFrom]);

  // Текст инструкции зависит от состояния.
  const instructionText = useMemo(() => {
    if (!drill) return '';
    if (feedback) {
      return feedback.solved
        ? t('drills.feedback.correct', 'Correct!')
        : t('drills.feedback.incorrect', 'Not quite');
    }
    const camel = kebabToCamel(drill.drillType);
    return t(`drills.instructions.${camel}`);
  }, [drill, feedback, t]);

  const instructionTone =
    feedback === null
      ? 'info'
      : feedback.solved
      ? 'success'
      : 'error';

  // ── Render ────────────────────────────────────────────────────────
  if (state === 'error') {
    return (
      <div
        className="drill-page drill-page--error"
        data-testid="drill-page"
        data-state="error"
        data-type={drillType ?? ''}
      >
        <DrillInstructions tone="error">
          {error === 'submitFailed'
            ? t('drills.errors.submitFailed', 'Could not submit answer.')
            : t('drills.errors.loadFailed', 'Could not load drill.')}
        </DrillInstructions>
        <button
          type="button"
          className="drill-page__retry-btn"
          data-testid="drill-page-retry"
          onClick={() => void fetchNext()}
        >
          {t('drills.buttons.tryAgain', 'Try again')}
        </button>
        <Link className="drill-page__back" to="/drills">
          {t('drills.buttons.backToLobby', 'Back to drills')}
        </Link>
      </div>
    );
  }

  if (state === 'loading' || !drill) {
    return (
      <div
        className="drill-page drill-page--loading"
        data-testid="drill-page"
        data-state="loading"
        data-type={drillType ?? ''}
      >
        <p>{t('drills.loading', 'Loading drills…')}</p>
      </div>
    );
  }

  return (
    <div
      className="drill-page"
      data-testid="drill-page"
      data-state={state}
      data-type={drillType}
      data-shape={drill.answerShape}
    >
      <header className="drill-page__header">
        <Link
          to="/drills"
          className="drill-page__back"
          data-testid="drill-page-back"
        >
          ← {t('drills.buttons.backToLobby', 'Back to drills')}
        </Link>
        <div
          className="drill-page__progress"
          data-testid="drill-page-progress"
          data-attempted={stats.attempted}
          data-solved={stats.solved}
        >
          {stats.solved} / {stats.attempted}
        </div>
        <div
          className="drill-page__timer"
          data-testid="drill-page-timer"
          data-elapsed-ms={elapsedMs}
        >
          {Math.floor(elapsedMs / 1000)}s
        </div>
      </header>

      <DrillInstructions tone={instructionTone}>
        {instructionText}
      </DrillInstructions>

      {drill.sideToMove && (
        <div
          className="drill-page__side"
          data-testid="drill-page-side"
          data-side={drill.sideToMove}
        >
          {drill.sideToMove === 'w'
            ? t('drills.side.whiteToMove', 'White to move')
            : t('drills.side.blackToMove', 'Black to move')}
        </div>
      )}

      <DrillBoard
        position={drill.fen}
        boardOrientation={drill.sideToMove === 'b' ? 'black' : 'white'}
        highlightedSquares={highlightedSquares}
        onSquareClick={handleSquareClick}
        overlay={
          feedback ? (
            <DrillFeedbackOverlay
              result={feedback.solved ? 'correct' : 'incorrect'}
            />
          ) : null
        }
      />

      <div className="drill-page__answer-controls" data-testid="drill-page-controls">
        {drill.answerShape === 'number' && (
          <DrillCountAttackersButtons
            disabled={state !== 'idle'}
            onSelect={handleNumberPick}
          />
        )}
        {drill.answerShape === 'squares' && (
          <>
            <span
              className="drill-page__squares-counter"
              data-testid="drill-page-squares-counter"
            >
              {pickedSquares.length}
              {drill.meta?.expectedCount !== undefined
                ? ` / ${drill.meta.expectedCount}`
                : ''}
            </span>
            <button
              type="button"
              className="drill-page__submit-btn"
              data-testid="drill-page-submit"
              disabled={state !== 'idle' || pickedSquares.length === 0}
              onClick={handleSubmitSquares}
            >
              {t('drills.buttons.submit', 'Submit')}
            </button>
          </>
        )}
        {drill.answerShape === 'move' && pickedFrom && (
          <span
            className="drill-page__move-hint"
            data-testid="drill-page-move-hint"
          >
            {pickedFrom} → ?
          </span>
        )}
      </div>

      {state === 'feedback' && (
        <button
          type="button"
          className="drill-page__next-btn"
          data-testid="drill-page-next"
          onClick={() => void fetchNext()}
        >
          {t('drills.buttons.next', 'Next drill')}
        </button>
      )}
    </div>
  );
}
