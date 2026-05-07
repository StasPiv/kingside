import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Chess, type Square as ChessSquare } from 'chess.js';
import type {
  AnswerData,
  TacticDrillAttemptResponse,
  TacticDrillDto,
  TacticDrillType,
} from '@kingside/shared';

import { DrillBoard, type DrillBoardArrow } from './DrillBoard';
import { DrillCountAttackersButtons, type DrillCountValue } from './DrillCountAttackersButtons';
import { DrillFeedbackOverlay } from './DrillFeedbackOverlay';
import { DrillInstructions } from './DrillInstructions';
import { DrillExplanationPanel } from './DrillExplanationPanel';
// KS-2326: специальный multi-step runner для find-all-checks.
import { FindAllChecksRunner } from './FindAllChecksRunner';
// KS-2423: звуки в тренажёрах — обёртка над useSounds с drill-only mute.
import { useDrillSounds, resolveMoveSound } from '../../hooks/useDrillSounds';
// KS-2457: explanation-engine — стрелки/highlights/notes по результату submit'а.
import { explainDrill } from './explanation/explainDrill';
import type { ArrowRole } from './explanation/types';

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

/**
 * KS-2333: drill-типы, где правильный ответ зависит от стороны
 * на ходу (см. backend-predicates `find-loose-piece.ts`,
 * `find-hanging-piece.ts`, `find-undefended-attack.ts` —
 * `enemy = oppColor(chess.turn())`).
 *
 * Контракт `TacticDrillDto.sideToMove` (shared/tactic-drill.ts:162) для
 * `find-loose-piece` сейчас возвращает `null` («side-to-move неважна»),
 * хотя на самом деле важна — пользователь не видит, фигуру какого
 * цвета искать. Здесь — список типов, для которых фронт извлекает
 * side-to-move ИЗ FEN'а самостоятельно, если backend не передал.
 *
 * Если backend позже начнёт отдавать `sideToMove` для этих типов —
 * fallback тихо отойдёт (в effectiveSideToMove приоритет у `drill.sideToMove`).
 */
const SIDE_SENSITIVE_DRILL_TYPES: ReadonlySet<TacticDrillType> = new Set<
  TacticDrillType
>([
  'find-loose-piece',
  'find-hanging-piece',
  'find-undefended-attack',
  // KS-2401: после миграции (KS-2399/KS-2400) find-fork — shape='move',
  // формулировка инструкции зависит от стороны хода (по образцу
  // find-undefended-attack).
  'find-fork',
]);

/** Извлечь side-to-move из второго поля FEN. Вернёт null при кривом FEN. */
function sideFromFen(fen: string): 'w' | 'b' | null {
  const parts = fen.split(' ');
  if (parts.length < 2) return null;
  const side = parts[1];
  return side === 'w' || side === 'b' ? side : null;
}

/**
 * KS-2457: placeholder-цвета стрелок по `ArrowRole`. Финальные —
 * KS-2458 layout (токенизация под темы). Pure-функция, безопасно вне
 * компонента.
 */
function arrowRoleColor(role: ArrowRole): string {
  switch (role) {
    case 'correct-attack':
    case 'correct-move':
      return '#16a34a'; // green
    case 'missed-attack':
      return '#94a3b8'; // gray
    case 'wrong-attack':
      return '#dc2626'; // red
    case 'pin-line':
      return '#f97316'; // orange
    case 'defense':
      return '#3b82f6'; // blue
    case 'threat-target':
      return '#dc2626'; // red
  }
}

/**
 * KS-2405: цвет фигуры на клетке (для проверки «свою» ли фигуру выбрал
 * пользователь при click-flow в drill shape='move'). Возвращает 'w' / 'b'
 * для фигуры, null если клетка пустая или кривой FEN.
 */
function pieceColorOnSquare(fen: string, square: string): 'w' | 'b' | null {
  try {
    const c = new Chess(fen);
    const piece = c.get(square as ChessSquare);
    return piece ? piece.color : null;
  } catch {
    return null;
  }
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
  // KS-2457: дефолт повышен с 1500 до 3500 — после неверного ответа
  // пользователь должен успеть рассмотреть стрелки и подсветки. KS-2454
  // методика: 3 секунды минимум на считывание разбора. Manual «Дальше»
  // через DrillExplanationPanel прерывает таймер.
  autoNextDelayIncorrectMs = 3500,
}: DrillRunnerProps) {
  const { t } = useTranslation();
  // KS-2423: drill-звуки. Обёртка над useSounds — уважает global mute и
  // отдельный drill-mute (`drills.soundsMuted`).
  const { play: playDrillSound } = useDrillSounds();

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

  // KS-2457: запоминаем ответ пользователя при submit'е, чтобы передать
  // его в `explainDrill()` при feedback (для wrong-highlights и
  // userAnswer-notes). Сбрасывается при загрузке нового drill'а.
  const [lastSubmittedAnswer, setLastSubmittedAnswer] = useState<AnswerData | null>(
    null,
  );

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
    // KS-2457: новый drill — сбрасываем сохранённый ответ.
    setLastSubmittedAnswer(null);
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
      // KS-2423: озвучиваем сам факт хода. Для shape='move' — move/capture,
      // shape='squares' — общий «move» как «принял ответ», shape='number'
      // не озвучиваем (там визуальный feedback от кнопки + дальше correct/
      // incorrect). Для shape='square' — move (тоже ответ-клик).
      if (userAnswer.shape === 'move') {
        playDrillSound(resolveMoveSound(drill.fen, userAnswer.from, userAnswer.to));
      } else if (userAnswer.shape === 'square' || userAnswer.shape === 'squares') {
        playDrillSound('move');
      }
      setState('submitting');
      // KS-2457: запоминаем `userAnswer` ДО submit'а — explanation-engine
      // использует его в feedback'е для wrong-highlights и userAnswer-нот.
      setLastSubmittedAnswer(userAnswer);
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
        // KS-2423: вердикт правильности.
        playDrillSound(resp.solved ? 'puzzle-correct' : 'puzzle-incorrect');
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
    [drill, state, attempted, solved, historyIndex, history.length, pickedSquares, pickedFrom, playDrillSound],
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
    // KS-2481: при неверном ответе auto-next ОТКЛЮЧЁН — пользователь
    // должен успеть рассмотреть стрелки/подсветки и текст разбора.
    // Переход только по клику «Дальше» в DrillExplanationPanel
    // (handleNext через onNext). При solved=true — старая логика.
    if (!feedback.solved) return;
    const reduced = prefersReducedMotion();
    const delay = reduced ? 0 : autoNextDelayCorrectMs;
    const id = setTimeout(() => {
      handleNext();
    }, Math.max(0, delay));
    return () => clearTimeout(id);
  }, [
    state,
    feedback,
    autoNextDelayCorrectMs,
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
          // KS-2423: для shape='square' клик = ответ; submit() озвучит
          // 'move' и далее verdict. Здесь дополнительный 'select' не
          // нужен (был бы двойной звук на одно действие).
          void submit({ shape: 'square', square: sq });
          break;
        case 'squares':
          // KS-2423: каждый клик — добавление/снятие клетки → 'select'.
          playDrillSound('select');
          setPickedSquares((prev) =>
            prev.includes(sq) ? prev.filter((x) => x !== sq) : [...prev, sq],
          );
          break;
        case 'move':
          if (pickedFrom === null) {
            // KS-2405: первый клик блокируется ТОЛЬКО если на клетке
            // явно стоит фигура чужого цвета. Пустая клетка / ошибка
            // парсинга FEN → пропускаем (старое поведение, дальше
            // backend сам ответит «неверно» — но привычная UX'у).
            const side =
              drill.sideToMove ?? sideFromFen(drill.fen);
            const pieceColor = pieceColorOnSquare(drill.fen, sq);
            if (side && pieceColor && pieceColor !== side) return;
            // KS-2423: pickup своей фигуры → 'select'.
            playDrillSound('select');
            setPickedFrom(sq);
          } else if (pickedFrom === sq) {
            // KS-2423: «отжали» уже выбранную клетку — тоже 'select'.
            playDrillSound('select');
            setPickedFrom(null);
          } else {
            void submit({ shape: 'move', from: pickedFrom, to: sq });
            setPickedFrom(null);
          }
          break;
        case 'number':
          break;
      }
    },
    [drill, pickedFrom, state, submit, playDrillSound],
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
      // KS-2405: не принимаем drop если фигура НЕ своего цвета.
      // useFastDrag это уже блокирует, но дублируем защиту здесь —
      // на случай если drop попадёт другим путём.
      const side = drill.sideToMove ?? sideFromFen(drill.fen);
      const pieceColor = pieceColorOnSquare(drill.fen, sourceSquare);
      if (side && pieceColor && pieceColor !== side) return false;
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

  // KS-2457: explanation вычисляется ОДИН раз при `state='feedback'` для
  // текущей пары (drill, feedback). Используется для:
  //  - role-based highlights на доске (`DrillBoard.roleHighlights`).
  //  - стрелок (`DrillBoard.arrows`).
  //  - текстовых notes в `DrillExplanationPanel`.
  // Когда мы вне feedback'а или drill ещё не загружен — null.
  const explanation = useMemo(() => {
    if (!drill || !feedback) return null;
    return explainDrill({
      drill,
      correctAnswer: feedback.correctAnswer,
      userAnswer: lastSubmittedAnswer,
      solved: feedback.solved,
    });
  }, [drill, feedback, lastSubmittedAnswer]);

  // KS-2457: arrows для DrillBoard. Цвета — placeholder (KS-2458 layout
  // финализирует). Memo по explanation — react-chessboard сравнивает
  // arrows по identity.
  const explanationArrows = useMemo<DrillBoardArrow[] | undefined>(() => {
    if (!explanation || explanation.arrows.length === 0) return undefined;
    return explanation.arrows.map((a) => ({
      startSquare: a.from,
      endSquare: a.to,
      color: arrowRoleColor(a.role),
    }));
  }, [explanation]);

  const highlightedSquares = useMemo<string[]>(() => {
    if (!drill) return [];
    // KS-2457: при feedback role-based highlights делает explanation —
    // плоский highlightedSquares оставляем пустым, чтобы не дублировать
    // подсветку.
    if (feedback) return [];
    if (drill.answerShape === 'squares') return pickedSquares;
    if (drill.answerShape === 'move' && pickedFrom) return [pickedFrom];
    if (drill.answerShape === 'number' && drill.meta?.highlightedSquare) {
      return [drill.meta.highlightedSquare];
    }
    return [];
  }, [drill, feedback, pickedSquares, pickedFrom]);

  // KS-2367: для count-attackers вопрос должен указывать цвет
  // атакующих (`drill.meta.attackerColor`), иначе пользователь не
  // знает, чьи фигуры считать. Поле появилось в БД после KS-2329 /
  // KS-2354; в shared `TacticDrillDto.meta` оно пока не описано —
  // читаем через runtime-cast, чтобы фронт работал и сейчас, и когда
  // backend расширит контракт.
  const attackerColor = ((drill?.meta ?? null) as
    | { attackerColor?: 'w' | 'b' }
    | null)?.attackerColor;

  // KS-2452: если на target-клетке стоит фигура того же цвета, что и
  // считаемая сторона — это «защищающие» (свои фигуры свою же клетку
  // защищают, а не атакуют). Если клетка пустая или фигура чужого
  // цвета — оставляем «атакующие».
  const countAttackersIsDefenders =
    drill?.drillType === 'count-attackers' &&
    !!attackerColor &&
    !!drill.meta?.highlightedSquare &&
    pieceColorOnSquare(drill.fen, drill.meta.highlightedSquare) === attackerColor;

  // KS-2386: для find-undefended-attack нужен side-to-move, чтобы
  // текст инструкции называл сторону хода и сторону защищающегося
  // («После какого хода белых у чёрных…»). Считаем его здесь
  // (дублирует effectiveSideToMove, но тот объявлен ниже по файлу
  // и недоступен в этом useMemo).
  const undefendedAttackSide: 'w' | 'b' | null =
    drill?.drillType === 'find-undefended-attack'
      ? drill.sideToMove ?? sideFromFen(drill.fen)
      : null;

  // KS-2401: то же самое для find-fork — после миграции shape='move'
  // (KS-2399/KS-2400) формулировка зависит от стороны хода
  // («Какой ход белых создаёт у чёрных новую вилку?»).
  const findForkSide: 'w' | 'b' | null =
    drill?.drillType === 'find-fork'
      ? drill.sideToMove ?? sideFromFen(drill.fen)
      : null;

  const instructionText = useMemo(() => {
    if (!drill) return '';
    if (feedback) {
      return feedback.solved
        ? t('drills.feedback.correct', 'Correct!')
        : t('drills.feedback.incorrect', 'Not quite');
    }
    if (drill.drillType === 'count-attackers' && attackerColor) {
      // KS-2452: своя фигура на target-клетке → defenders, иначе attackers.
      if (countAttackersIsDefenders) {
        return attackerColor === 'w'
          ? t(
              'drills.instructions.countDefendersWhite',
              'How many WHITE pieces defend the highlighted square?',
            )
          : t(
              'drills.instructions.countDefendersBlack',
              'How many BLACK pieces defend the highlighted square?',
            );
      }
      return attackerColor === 'w'
        ? t(
            'drills.instructions.countAttackersWhite',
            'How many WHITE pieces attack the highlighted square?',
          )
        : t(
            'drills.instructions.countAttackersBlack',
            'How many BLACK pieces attack the highlighted square?',
          );
    }
    if (drill.drillType === 'find-undefended-attack' && undefendedAttackSide) {
      return undefendedAttackSide === 'w'
        ? t(
            'drills.instructions.findUndefendedAttackWhite',
            'After which White move does Black end up with one more undefended piece?',
          )
        : t(
            'drills.instructions.findUndefendedAttackBlack',
            'After which Black move does White end up with one more undefended piece?',
          );
    }
    if (drill.drillType === 'find-fork' && findForkSide) {
      return findForkSide === 'w'
        ? t(
            'drills.instructions.findForkWhite',
            'Which White move creates a new fork for Black?',
          )
        : t(
            'drills.instructions.findForkBlack',
            'Which Black move creates a new fork for White?',
          );
    }
    return t(`drills.instructions.${kebabToCamel(drill.drillType)}`);
  }, [
    drill,
    feedback,
    t,
    attackerColor,
    countAttackersIsDefenders,
    undefendedAttackSide,
    findForkSide,
  ]);

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
        {/* KS-2559: для find-all-checks убран дубль `__progress` —
            FindAllChecksRunner ниже сам рендерит ряд `.drill-runner__stats`
            с тремя ячейками (Найдено/Попыток/Время), выводящими
            актуальный прогресс ВНУТРИ drill'а (`found / expected`).
            Старый общий `solved / count` (0/0 при count=Infinity) был
            мало-информативен и шёл голым текстом. */}
        <FindAllChecksRunner
          drill={drill}
          submitAnswer={(input) => submitAnswerRef.current(input)}
          // KS-2460: пробрасываем те же auto-next-задержки, что у
          // обычных drill'ов в DrillRunner. По умолчанию у FACR
          // короткое продолжение для solved (0мс) и длинное для
          // ошибки (3500мс) — чтобы успеть рассмотреть финальный
          // разбор с missed/FP-стрелками.
          autoNextDelayCorrectMs={autoNextDelayCorrectMs}
          autoNextDelayIncorrectMs={autoNextDelayIncorrectMs}
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

  // KS-2333: фактический side-to-move для отображения индикатора
  // «ход белых / чёрных». Приоритет у `drill.sideToMove` от backend;
  // если null — для side-sensitive типов извлекаем из FEN.
  const effectiveSideToMove: 'w' | 'b' | null = drill.sideToMove
    ? drill.sideToMove
    : SIDE_SENSITIVE_DRILL_TYPES.has(drill.drillType)
      ? sideFromFen(drill.fen)
      : null;

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

      {/* KS-2558: ряд stats-ячеек (Решено / Попытки / Время) аналогично
          `.precision-stats` на /precision. data-testid у `__progress` и
          `__timer` сохранены — старые селекторы тестов работают. */}
      {(!hideProgress || !hideTimer) && (
        <div
          className="drill-runner__stats"
          data-testid="drill-runner-stats"
        >
          {!hideProgress && (
            <div
              className="drill-runner__stats-cell drill-runner__progress"
              data-testid="drill-runner-progress"
              data-attempted={attempted}
              data-solved={solved}
            >
              <span className="drill-runner__stats-value">
                {solved} / {Number.isFinite(count) ? count : attempted}
              </span>
              <span className="drill-runner__stats-label">
                {contextLabel
                  ? contextLabel
                  : t('drills.runner.stats.solved', 'Solved')}
              </span>
            </div>
          )}

          {!hideProgress && (
            <div
              className="drill-runner__stats-cell"
              data-testid="drill-runner-attempted"
              data-attempted={attempted}
            >
              <span className="drill-runner__stats-value">{attempted}</span>
              <span className="drill-runner__stats-label">
                {t('drills.runner.stats.attempts', 'Attempts')}
              </span>
            </div>
          )}

          {!hideTimer && (
            <div
              className="drill-runner__stats-cell drill-runner__timer"
              data-testid="drill-runner-timer"
              data-elapsed-ms={elapsedMs}
            >
              <span className="drill-runner__stats-value">
                {Math.floor(elapsedMs / 1000)}s
              </span>
              <span className="drill-runner__stats-label">
                {t('drills.runner.stats.time', 'Time')}
              </span>
            </div>
          )}
        </div>
      )}

      <DrillInstructions tone={instructionTone}>
        {instructionText}
      </DrillInstructions>

      {effectiveSideToMove && (
        <div
          className="drill-runner__side"
          data-testid="drill-runner-side"
          data-side={effectiveSideToMove}
        >
          {effectiveSideToMove === 'w'
            ? t('drills.side.whiteToMove', 'White to move')
            : t('drills.side.blackToMove', 'Black to move')}
        </div>
      )}

      {/* KS-2367: для count-attackers — индикатор цвета атакующих
          (тот же визуальный стиль что side-to-move в KS-2333: цветной
          кружок + подпись). Показываем только если backend отдал
          `meta.attackerColor`; иначе текст инструкции показывает обычный
          вариант без цвета (back-compat). */}
      {drill.drillType === 'count-attackers' && attackerColor && (
        <div
          className="drill-runner__side drill-runner__side--attackers"
          data-testid="drill-runner-attacker-color"
          data-side={attackerColor}
          data-role={countAttackersIsDefenders ? 'defenders' : 'attackers'}
        >
          {/* KS-2452: pill показывает «Защищающие — …» если своя фигура
              на target-клетке (своя сторона свою же клетку защищает),
              иначе обычное «Атакующие — …». */}
          {countAttackersIsDefenders
            ? attackerColor === 'w'
              ? t('drills.side.whiteDefenders', 'White defenders')
              : t('drills.side.blackDefenders', 'Black defenders')
            : attackerColor === 'w'
              ? t('drills.side.whiteAttackers', 'White attackers')
              : t('drills.side.blackAttackers', 'Black attackers')}
        </div>
      )}

      {/* KS-2457: обёртка board+panel — flex-row на desktop (≥768px),
          flex-column на mobile (см. drills.css). Панель появляется при
          feedback'е, board остаётся по центру/слева. */}
      <div className="drill-runner__board-and-panel">
        <DrillBoard
          position={drill.fen}
          boardOrientation={drill.sideToMove === 'b' ? 'black' : 'white'}
          highlightedSquares={highlightedSquares}
          // KS-2457: role-based подсветки и стрелки во время feedback'а.
          roleHighlights={explanation?.highlights}
          arrows={explanationArrows}
          onSquareClick={handleSquareClick}
          // KS-2318: drag-and-drop ввод хода для shape='move'.
          // Click-click продолжает работать через onSquareClick.
          onPieceDrop={
            drill.answerShape === 'move' ? handlePieceDrop : undefined
          }
          // KS-2426: pickup-звук на drag (click-pickup уже озвучен в
          // handleSquareClick).
          onPiecePickup={
            drill.answerShape === 'move'
              ? () => playDrillSound('select')
              : undefined
          }
          overlay={
            feedback ? (
              <DrillFeedbackOverlay
                result={feedback.solved ? 'correct' : 'incorrect'}
              />
            ) : null
          }
        />
        {/* KS-2457: explanation-panel рядом с доской — только при
            feedback'е и только если мы на хвосте истории (для
            исторических позиций панель не нужна, юзер уже её видел). */}
        {state === 'feedback' && explanation && feedback && (
          <DrillExplanationPanel
            explanation={explanation}
            solved={feedback.solved}
            // KS-2457: manual «Дальше» прерывает auto-next-таймер
            // (effect cleanup автоматически clearTimeout сделает при
            // смене state в handleNext) и грузит следующий drill.
            onNext={handleNext}
          />
        )}
      </div>

      <div
        className="drill-runner__answer-controls"
        data-testid="drill-runner-controls"
      >
        {/* KS-2457: при feedback'е count-attackers панель замещает
            кнопки чисел — пользователь видит разбор, а не тот же ряд
            disabled-кнопок 1..4. */}
        {drill.answerShape === 'number' && state !== 'feedback' && (
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
