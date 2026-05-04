import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { Square as ChessSquare } from 'chess.js';
import type {
  AnswerData,
  TacticDrillAttemptResponse,
  TacticDrillDto,
} from '@kingside/shared';

import { DrillBoard } from './DrillBoard';
import { DrillCountAttackersButtons, type DrillCountValue } from './DrillCountAttackersButtons';
import { DrillFeedbackOverlay } from './DrillFeedbackOverlay';
import { DrillInstructions } from './DrillInstructions';
// KS-2326: специальный multi-step runner для find-all-checks.
import { FindAllChecksRunner } from './FindAllChecksRunner';

/**
 * KS-2249 (ADR-035 §11, Drills E6) — переиспользуемый runner drill'а.
 *
 * Извлечён из `DrillPage` (KS-2233) — ровно та же state-machine
 * (`loading → idle → submitting → feedback → loading|done|error`),
 * но без зависимости от React Router и `api`-клиента. Принимает
 * loader/submitter callbacks через props — host решает, откуда брать
 * drill'ы:
 *   - `DrillPage` (standalone): loader = `GET /tactic-drill/next?type=`,
 *     submitter = `POST /tactic-drill/attempt` с `mode='drill'`.
 *   - `DrillStep` в lesson player (KS-2249): loader = `GET
 *     /tactic-drill/by-step/:stepId` (KS-2315 backend, в работе) или
 *     fallback `/tactic-drill/next?type=`, submitter = тот же `/attempt`
 *     с `mode='lessons-embed'`.
 *
 * # count / minSolved
 *
 * - `count` (опц.) — сколько drill'ов подряд показать. По умолчанию
 *   `Infinity` (бесконечный режим, как у standalone DrillPage).
 * - `minSolved` (опц., default = `count`) — порог success'а. Если
 *   `count === Infinity` → minSolved игнорируется, success-переход не
 *   срабатывает.
 * - При достижении `attempted >= count` → `state='done'` + вызов
 *   `onComplete({ solved, attempted, success })`. Host решает, что
 *   показать дальше (Continue / Retry / итог).
 *
 * # Контракт DOM
 *
 *   <div class="drill-runner" data-testid="drill-runner"
 *        data-state="loading|idle|submitting|feedback|done|error"
 *        data-shape="…" data-attempted="N" data-solved="N"
 *        data-count="N|infinity" data-min-solved="N|0">
 *     {headerSlot}        // optional
 *     <DrillInstructions tone="…">…</DrillInstructions>
 *     <DrillBoard … overlay={<DrillFeedbackOverlay …/>} />
 *     <div class="drill-runner__answer-controls">…</div>
 *     <button data-testid="drill-runner-continue">…</button> // в done + success
 *     <button data-testid="drill-runner-retry">…</button>    // в done + !success или error
 *   </div>
 *
 * # KS-2319 / KS-2323 — авто-переход после feedback
 *
 * Кнопка «Следующее» удалена. Когда `state='feedback'` — `useEffect`
 * запускает `setTimeout(handleNext, delay)`:
 *  - правильный ответ → `autoNextDelayCorrectMs` (default 0, drill
 *    на скорость);
 *  - неверный → `autoNextDelayIncorrectMs` (default 1500, время
 *    рассмотреть подсветку правильного ответа).
 * При `prefers-reduced-motion: reduce` runtime-override на 0 в обоих
 * случаях. Cleanup на unmount/новом feedback — нет двойного перехода
 * и leak'а таймера.
 */

export type DrillRunnerState =
  | 'loading'
  | 'idle'
  | 'submitting'
  | 'feedback'
  | 'done'
  | 'error';

/**
 * KS-2330: размер локальной истории drill'ов (последние N показанных
 * в текущей сессии). При переполнении — самые старые вытесняются.
 */
export const DRILL_HISTORY_LIMIT = 10;

/**
 * KS-2330: один элемент локальной истории. `feedback === null` означает,
 * что drill ещё не отвечен (только текущий, «живой» drill может быть в
 * таком состоянии). `pickedSquares` / `pickedFrom` — снэпшот ввода
 * пользователя на момент ухода с позиции.
 */
interface HistoryEntry {
  drill: TacticDrillDto;
  feedback: { solved: boolean; correctAnswer: AnswerData } | null;
  pickedSquares: string[];
  pickedFrom: string | null;
}

export interface DrillRunnerCompletion {
  solved: number;
  attempted: number;
  success: boolean;
}

export interface DrillRunnerSubmitInput {
  drillId: string;
  userAnswer: AnswerData;
  timeMs: number;
}

export interface DrillRunnerProps {
  /** Загрузить следующий drill (или первый при mount). */
  loadDrill: () => Promise<TacticDrillDto>;
  /** Отправить ответ и получить результат + correctAnswer для feedback. */
  submitAnswer: (input: DrillRunnerSubmitInput) => Promise<TacticDrillAttemptResponse>;
  /**
   * Сколько drill'ов всего показать. По умолчанию бесконечно
   * (Infinity) — runner после каждого feedback грузит следующий и
   * никогда не уходит в `done`.
   */
  count?: number;
  /** Порог success'а: solved >= minSolved → success=true. Default = count. */
  minSolved?: number;
  /** Колбэк по завершению count attempts (только если count конечный). */
  onComplete?: (result: DrillRunnerCompletion) => void;
  /** Reset тикера попыток при mount. По умолчанию true (свежий mount = свежая сессия). */
  resetOnMount?: boolean;
  /** Header-слот (back-link/title/etc). Если null — header не рендерится. */
  headerSlot?: ReactNode;
  /**
   * Лейбл кнопки «Continue» в done-state (когда success). По умолчанию
   * "Next drill" (drills.buttons.next). DrillStep в lesson player
   * передаёт «Далее» / «Continue».
   */
  continueLabel?: string;
  /** Лейбл retry-кнопки в error/fail-state. Default — drills.buttons.tryAgain. */
  retryLabel?: string;
  /**
   * Если задан — отображается рядом с прогрессом (полезно для
   * lesson-embed: «Шаг 1/3»).
   */
  contextLabel?: string;
  /** Скрыть встроенный progress-блок (count solved/attempted). Default false. */
  hideProgress?: boolean;
  /** Скрыть встроенный таймер. Default false. */
  hideTimer?: boolean;
  /** Тестовый testid override (для нескольких runner'ов на странице). */
  testId?: string;
  /**
   * KS-2323: задержка (мс) после ПРАВИЛЬНОГО ответа. Default `0` —
   * drill на скорость, мгновенный переход. При
   * `prefers-reduced-motion: reduce` всё равно `0`.
   */
  autoNextDelayCorrectMs?: number;
  /**
   * KS-2323: задержка (мс) после НЕВЕРНОГО ответа. Default `1500` —
   * нужно успеть рассмотреть подсветку правильного ответа. При
   * `prefers-reduced-motion: reduce` runtime override на `0` (юзер
   * сам контролирует темп через системную настройку).
   */
  autoNextDelayIncorrectMs?: number;
}

/** KS-2319: matchMedia для prefers-reduced-motion. SSR-safe. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function DrillRunner({
  loadDrill,
  submitAnswer,
  count = Infinity,
  minSolved,
  onComplete,
  resetOnMount = true,
  headerSlot,
  continueLabel,
  retryLabel,
  contextLabel,
  hideProgress = false,
  hideTimer = false,
  testId = 'drill-runner',
  autoNextDelayCorrectMs = 0,
  autoNextDelayIncorrectMs = 1500,
}: DrillRunnerProps) {
  const { t } = useTranslation();

  const effectiveMinSolved = minSolved ?? (Number.isFinite(count) ? count : 0);

  const [state, setState] = useState<DrillRunnerState>('loading');
  const [drill, setDrill] = useState<TacticDrillDto | null>(null);
  const [error, setError] = useState<'loadFailed' | 'submitFailed' | null>(null);
  const [attempted, setAttempted] = useState(0);
  const [solved, setSolved] = useState(0);
  const [feedback, setFeedback] = useState<{
    solved: boolean;
    correctAnswer: AnswerData;
  } | null>(null);

  // Накапливаемые ответы (squares / move).
  const [pickedSquares, setPickedSquares] = useState<string[]>([]);
  const [pickedFrom, setPickedFrom] = useState<string | null>(null);

  // KS-2330: локальная история показанных drill'ов в текущей сессии.
  // Стек на N=10 элементов (старые вытесняются). Снэпшот включает сам
  // drill + результат submit'а (если есть) и ввод пользователя на момент
  // ухода с позиции — чтобы вернуться к ней «как было».
  // historyIndex указывает на индекс текущего отображаемого drill'а в
  // history. -1 — до первой загрузки (mount, history ещё пустая).
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  // Per-drill таймер.
  const startedAtRef = useRef<number>(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  // KS-2249: фиксируем последний loader, чтобы при перерисовке host'а
  // (например, новый stepId) перезапускать загрузку. Сравниваем по
  // ссылке — host должен мемоизировать loader через useCallback, иначе
  // получит лавину /next.
  const loadDrillRef = useRef(loadDrill);
  loadDrillRef.current = loadDrill;
  const submitAnswerRef = useRef(submitAnswer);
  submitAnswerRef.current = submitAnswer;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const fetchNext = useCallback(async () => {
    setState('loading');
    setError(null);
    setFeedback(null);
    setPickedSquares([]);
    setPickedFrom(null);
    setElapsedMs(0);
    try {
      const next = await loadDrillRef.current();
      setDrill(next);
      startedAtRef.current = Date.now();
      setState('idle');
      // KS-2330: пушим новый drill в стек истории, обрезая до
      // DRILL_HISTORY_LIMIT последних. Текущий drill всегда последний
      // в стеке (historyIndex = length-1) — по нему идёт submit.
      setHistory((prev) => {
        const next_arr: HistoryEntry[] = [
          ...prev,
          {
            drill: next,
            feedback: null,
            pickedSquares: [],
            pickedFrom: null,
          },
        ];
        const trimmed =
          next_arr.length > DRILL_HISTORY_LIMIT
            ? next_arr.slice(next_arr.length - DRILL_HISTORY_LIMIT)
            : next_arr;
        setHistoryIndex(trimmed.length - 1);
        return trimmed;
      });
    } catch {
      setError('loadFailed');
      setState('error');
    }
  }, []);

  // Mount + reset.
  useEffect(() => {
    if (resetOnMount) {
      setAttempted(0);
      setSolved(0);
      // KS-2330: новая сессия — чистый стек истории.
      setHistory([]);
      setHistoryIndex(-1);
    }
    void fetchNext();
    // resetOnMount/loadDrill — явное намерение перезапустить в host'е,
    // resolver KS-2315 поменяется → пересоздание контекста.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDrill]);

  // Тикающий таймер.
  useEffect(() => {
    if (state !== 'idle') return;
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 250);
    return () => clearInterval(id);
  }, [state]);

  const finishIfDone = useCallback(
    (nextAttempted: number, nextSolved: number) => {
      if (!Number.isFinite(count)) return false;
      if (nextAttempted < count) return false;
      const success = nextSolved >= effectiveMinSolved;
      setState('done');
      onCompleteRef.current?.({
        solved: nextSolved,
        attempted: nextAttempted,
        success,
      });
      return true;
    },
    [count, effectiveMinSolved],
  );

  const submit = useCallback(
    async (userAnswer: AnswerData) => {
      if (!drill || state !== 'idle') return;
      // KS-2330: submit разрешён только на «живом» (последнем) drill'е
      // стека. Если пользователь смотрит историческую позицию — feedback
      // там уже есть, state='feedback', и в этот if мы не зайдём, но
      // защищаемся явно от случая, когда живой drill оказался не на
      // хвосте (например, из-за гонки fetchNext).
      if (historyIndex !== history.length - 1) return;
      const timeMs = Date.now() - startedAtRef.current;
      setState('submitting');
      try {
        const resp = await submitAnswerRef.current({
          drillId: drill.id,
          userAnswer,
          timeMs,
        });
        const nextAttempted = attempted + 1;
        const nextSolved = solved + (resp.solved ? 1 : 0);
        setAttempted(nextAttempted);
        setSolved(nextSolved);
        const fb = {
          solved: resp.solved,
          correctAnswer: resp.correctAnswer,
        };
        setFeedback(fb);
        // KS-2330: записываем результат + ввод пользователя в текущую
        // запись истории, чтобы при возврате «Назад → Вперёд» видеть
        // тот же feedback и тот же ответ.
        setHistory((prev) => {
          if (prev.length === 0) return prev;
          const lastIdx = prev.length - 1;
          const updated = [...prev];
          updated[lastIdx] = {
            ...updated[lastIdx],
            feedback: fb,
            pickedSquares: [...pickedSquares],
            pickedFrom,
          };
          return updated;
        });
        // Если это последний drill — даём показать feedback, потом done
        // переход через handleNext (юзер сам нажмёт Continue/Retry).
        // Финиш-проверку откладываем до handleNext — иначе feedback
        // мелькнёт и сразу скроется.
        setState('feedback');
      } catch {
        setError('submitFailed');
        setState('error');
      }
    },
    [drill, state, attempted, solved, historyIndex, history.length, pickedSquares, pickedFrom],
  );

  const handleNext = useCallback(() => {
    // Если набрали count attempts — финишируем. Иначе грузим следующий.
    if (finishIfDone(attempted, solved)) return;
    void fetchNext();
  }, [finishIfDone, fetchNext, attempted, solved]);

  // KS-2330: переключение на drill из истории по индексу. Восстанавливает
  // снэпшот: drill, picks, feedback (если был). При наличии feedback'а
  // — state='feedback', чтобы submit не сработал повторно (см. submit).
  // Без feedback'а — state='idle' (это «живой» хвостовой drill).
  const goToHistory = useCallback(
    (index: number) => {
      setHistory((prev) => {
        if (index < 0 || index >= prev.length) return prev;
        // Сохраняем текущий ввод пользователя в historyIndex, чтобы при
        // возврате на эту позицию увидеть выбранные клетки.
        const updated = [...prev];
        if (historyIndex >= 0 && historyIndex < updated.length) {
          updated[historyIndex] = {
            ...updated[historyIndex],
            pickedSquares: [...pickedSquares],
            pickedFrom,
          };
        }
        const entry = updated[index];
        setHistoryIndex(index);
        setDrill(entry.drill);
        setPickedSquares([...entry.pickedSquares]);
        setPickedFrom(entry.pickedFrom);
        setFeedback(entry.feedback);
        setError(null);
        setState(entry.feedback ? 'feedback' : 'idle');
        // Сбрасываем таймер показа — отсчитывается заново для текущего
        // отображаемого drill'а (даже исторического). Не влияет на
        // attempted/solved.
        startedAtRef.current = Date.now();
        setElapsedMs(0);
        return updated;
      });
    },
    [historyIndex, pickedSquares, pickedFrom],
  );

  const canGoBack = historyIndex > 0;
  const canGoForward =
    historyIndex >= 0 &&
    (historyIndex < history.length - 1 || feedback !== null);

  const handleBack = useCallback(() => {
    if (!canGoBack) return;
    goToHistory(historyIndex - 1);
  }, [canGoBack, goToHistory, historyIndex]);

  const handleForward = useCallback(() => {
    if (!canGoForward) return;
    if (historyIndex < history.length - 1) {
      goToHistory(historyIndex + 1);
      return;
    }
    // На хвосте + есть feedback → грузим новый drill (как при auto-next).
    handleNext();
  }, [canGoForward, goToHistory, handleNext, historyIndex, history.length]);

  // KS-2319 / KS-2323: авто-переход через delay после feedback.
  // Кнопка «Следующее» удалена.
  //  - Правильный ответ → delay=autoNextDelayCorrectMs (default 0,
  //    drill на скорость, мгновенный переход).
  //  - Неверный ответ → delay=autoNextDelayIncorrectMs (default 1500,
  //    нужно успеть рассмотреть подсветку правильного ответа).
  //  - prefers-reduced-motion: reduce → оба override на 0.
  // При unmount/новом feedback — clearTimeout, без leak'а / двойного перехода.
  //
  // KS-2330: авто-переход срабатывает ТОЛЬКО когда мы на хвосте истории
  // (свежий submit). При просмотре исторической позиции пользователь
  // должен сам ткнуть «Вперёд» — иначе любой переход в feedback при
  // возврате назад моментально промотал бы юзера обратно вперёд.
  useEffect(() => {
    if (state !== 'feedback' || !feedback) return;
    if (historyIndex !== history.length - 1) return;
    const reduced = prefersReducedMotion();
    const baseDelay = feedback.solved
      ? autoNextDelayCorrectMs
      : autoNextDelayIncorrectMs;
    const delay = reduced ? 0 : baseDelay;
    const id = setTimeout(() => {
      handleNext();
    }, Math.max(0, delay));
    return () => clearTimeout(id);
  }, [
    state,
    feedback,
    autoNextDelayCorrectMs,
    autoNextDelayIncorrectMs,
    handleNext,
    historyIndex,
    history.length,
  ]);

  // ── Click handlers ────────────────────────────────────────────────
  const handleSquareClick = useCallback(
    (sq: ChessSquare) => {
      if (state !== 'idle' || !drill) return;
      switch (drill.answerShape) {
        case 'square':
          void submit({ shape: 'square', square: sq });
          break;
        case 'squares':
          setPickedSquares((prev) =>
            prev.includes(sq) ? prev.filter((x) => x !== sq) : [...prev, sq],
          );
          break;
        case 'move':
          if (pickedFrom === null) setPickedFrom(sq);
          else if (pickedFrom === sq) setPickedFrom(null);
          else {
            void submit({ shape: 'move', from: pickedFrom, to: sq });
            setPickedFrom(null);
          }
          break;
        case 'number':
          break;
      }
    },
    [drill, pickedFrom, state, submit],
  );

  const handleNumberPick = useCallback(
    (n: DrillCountValue) => {
      void submit({ shape: 'number', value: n });
    },
    [submit],
  );

  const handleSubmitSquares = useCallback(() => {
    if (pickedSquares.length === 0) return;
    void submit({ shape: 'squares', squares: pickedSquares });
  }, [pickedSquares, submit]);

  // KS-2318: drag-and-drop ввод хода для shape='move'. Параллельно
  // click-click продолжает работать (handleSquareClick). Возвращаем
  // boolean (контракт useFastDrag), но реальное значение нам неважно —
  // submit идёт асинхронно.
  const handlePieceDrop = useCallback(
    (args: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (state !== 'idle' || !drill) return false;
      if (drill.answerShape !== 'move') return false;
      const { sourceSquare, targetSquare } = args;
      if (!sourceSquare || !targetSquare) return false;
      if (sourceSquare === targetSquare) return false;
      // Сбросим click-state чтобы не было гонки click-click и drag.
      setPickedFrom(null);
      void submit({
        shape: 'move',
        from: sourceSquare,
        to: targetSquare,
      });
      return true;
    },
    [drill, state, submit],
  );

  // ── Visuals ───────────────────────────────────────────────────────
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

  const success = solved >= effectiveMinSolved;

  // ── Render: error ─────────────────────────────────────────────────
  if (state === 'error') {
    return (
      <div
        className="drill-runner drill-runner--error"
        data-testid={testId}
        data-state="error"
      >
        {headerSlot}
        <DrillInstructions tone="error">
          {error === 'submitFailed'
            ? t('drills.errors.submitFailed', 'Could not submit answer.')
            : t('drills.errors.loadFailed', 'Could not load drill.')}
        </DrillInstructions>
        <button
          type="button"
          className="drill-runner__retry"
          data-testid="drill-runner-retry"
          onClick={() => void fetchNext()}
        >
          {retryLabel ?? t('drills.buttons.tryAgain', 'Try again')}
        </button>
      </div>
    );
  }

  // ── Render: loading ───────────────────────────────────────────────
  if (state === 'loading' || !drill) {
    return (
      <div
        className="drill-runner drill-runner--loading"
        data-testid={testId}
        data-state="loading"
      >
        {headerSlot}
        <p>{t('drills.loading', 'Loading drills…')}</p>
      </div>
    );
  }

  // ── Render: find-all-checks (KS-2326) — multi-step runner ─────────
  // Этот drill-type имеет свою state-machine (подсчёт found через
  // последовательные ходы с auto-undo), не вписывается в стандартный
  // submit-once-per-drill flow. После onComplete от FACR — инкремент
  // attempted/solved + finishIfDone || fetchNext (без feedback-state
  // в DrillRunner, FACR показал свой feedback внутри).
  if (drill.drillType === 'find-all-checks' && state === 'idle') {
    return (
      <div
        className="drill-runner drill-runner--find-all-checks"
        data-testid={testId}
        data-state="idle"
        data-shape="moves"
        data-attempted={attempted}
        data-solved={solved}
        data-count={Number.isFinite(count) ? String(count) : 'infinity'}
      >
        {headerSlot}
        {!hideProgress && (
          <div
            className="drill-runner__progress"
            data-testid="drill-runner-progress"
            data-attempted={attempted}
            data-solved={solved}
          >
            {contextLabel && (
              <span className="drill-runner__context">{contextLabel} · </span>
            )}
            {solved} / {Number.isFinite(count) ? count : attempted}
          </div>
        )}
        <FindAllChecksRunner
          drill={drill}
          submitAnswer={(input) => submitAnswerRef.current(input)}
          onComplete={({ solved: ok }) => {
            const nextAttempted = attempted + 1;
            const nextSolved = solved + (ok ? 1 : 0);
            setAttempted(nextAttempted);
            setSolved(nextSolved);
            // Сразу решаем: финиш по count или следующий drill.
            if (!finishIfDone(nextAttempted, nextSolved)) {
              void fetchNext();
            }
          }}
        />
      </div>
    );
  }

  // ── Render: done (count finite + достигли) ────────────────────────
  if (state === 'done') {
    return (
      <div
        className="drill-runner drill-runner--done"
        data-testid={testId}
        data-state="done"
        data-attempted={attempted}
        data-solved={solved}
        data-success={success ? 'true' : 'false'}
      >
        {headerSlot}
        <DrillInstructions tone={success ? 'success' : 'error'}>
          {success
            ? t('drills.feedback.correct', 'Correct!')
            : t('drills.feedback.incorrect', 'Not quite')}
        </DrillInstructions>
        <div
          className="drill-runner__final-progress"
          data-testid="drill-runner-final-progress"
        >
          {solved} / {attempted}
        </div>
        {success ? (
          <button
            type="button"
            className="drill-runner__continue"
            data-testid="drill-runner-continue"
            onClick={() =>
              onCompleteRef.current?.({ solved, attempted, success: true })
            }
          >
            {continueLabel ?? t('drills.buttons.next', 'Next')}
          </button>
        ) : (
          <button
            type="button"
            className="drill-runner__retry"
            data-testid="drill-runner-retry"
            onClick={() => {
              setAttempted(0);
              setSolved(0);
              void fetchNext();
            }}
          >
            {retryLabel ?? t('drills.buttons.tryAgain', 'Try again')}
          </button>
        )}
      </div>
    );
  }

  // KS-2330: индикатор «мы смотрим историческую позицию» — для тестов
  // и стилизации. На хвосте истории (свежий drill) — false.
  const viewingHistory = historyIndex >= 0 && historyIndex < history.length - 1;

  // ── Render: idle / submitting / feedback ──────────────────────────
  return (
    <div
      className="drill-runner"
      data-testid={testId}
      data-state={state}
      data-shape={drill.answerShape}
      data-attempted={attempted}
      data-solved={solved}
      data-count={Number.isFinite(count) ? String(count) : 'infinity'}
      data-min-solved={String(effectiveMinSolved)}
      data-viewing-history={viewingHistory ? 'true' : 'false'}
      data-history-index={String(historyIndex)}
      data-history-size={String(history.length)}
    >
      {headerSlot}

      <div
        className="drill-runner__nav"
        data-testid="drill-runner-nav"
      >
        <button
          type="button"
          className="drill-runner__nav-btn drill-runner__nav-btn--back"
          data-testid="drill-runner-back"
          aria-label={t('drills.buttons.back', 'Previous drill')}
          disabled={!canGoBack}
          onClick={handleBack}
        >
          ← {t('drills.buttons.back', 'Previous drill')}
        </button>
        <button
          type="button"
          className="drill-runner__nav-btn drill-runner__nav-btn--forward"
          data-testid="drill-runner-forward"
          aria-label={t('drills.buttons.forward', 'Next drill')}
          disabled={!canGoForward}
          onClick={handleForward}
        >
          {t('drills.buttons.forward', 'Next drill')} →
        </button>
      </div>

      {!hideProgress && (
        <div
          className="drill-runner__progress"
          data-testid="drill-runner-progress"
          data-attempted={attempted}
          data-solved={solved}
        >
          {contextLabel && (
            <span className="drill-runner__context">{contextLabel} · </span>
          )}
          {solved} / {Number.isFinite(count) ? count : attempted}
        </div>
      )}

      {!hideTimer && (
        <div
          className="drill-runner__timer"
          data-testid="drill-runner-timer"
          data-elapsed-ms={elapsedMs}
        >
          {Math.floor(elapsedMs / 1000)}s
        </div>
      )}

      <DrillInstructions tone={instructionTone}>
        {instructionText}
      </DrillInstructions>

      {drill.sideToMove && (
        <div
          className="drill-runner__side"
          data-testid="drill-runner-side"
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
        // KS-2318: drag-and-drop ввод хода для shape='move'.
        // Click-click продолжает работать через onSquareClick.
        onPieceDrop={
          drill.answerShape === 'move' ? handlePieceDrop : undefined
        }
        overlay={
          feedback ? (
            <DrillFeedbackOverlay
              result={feedback.solved ? 'correct' : 'incorrect'}
            />
          ) : null
        }
      />

      <div
        className="drill-runner__answer-controls"
        data-testid="drill-runner-controls"
      >
        {drill.answerShape === 'number' && (
          <DrillCountAttackersButtons
            disabled={state !== 'idle'}
            onSelect={handleNumberPick}
          />
        )}
        {drill.answerShape === 'squares' && (
          <>
            <span
              className="drill-runner__squares-counter"
              data-testid="drill-runner-squares-counter"
            >
              {pickedSquares.length}
              {drill.meta?.expectedCount !== undefined
                ? ` / ${drill.meta.expectedCount}`
                : ''}
            </span>
            <button
              type="button"
              className="drill-runner__submit"
              data-testid="drill-runner-submit"
              disabled={state !== 'idle' || pickedSquares.length === 0}
              onClick={handleSubmitSquares}
            >
              {t('drills.buttons.submit', 'Submit')}
            </button>
          </>
        )}
        {drill.answerShape === 'move' && pickedFrom && (
          <span
            className="drill-runner__move-hint"
            data-testid="drill-runner-move-hint"
          >
            {pickedFrom} → ?
          </span>
        )}
      </div>

      {/* KS-2319: кнопка «Следующее» удалена — авто-переход через
          setTimeout с delay по результату. См. useEffect выше. */}
    </div>
  );
}
