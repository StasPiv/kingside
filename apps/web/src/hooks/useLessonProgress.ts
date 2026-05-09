import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CompleteLessonResponse,
  LessonStepState,
  UserCoursePlayProgressDto,
  UserLessonProgress,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';

/**
 * Универсальный хук прогресса урока (system + user-курсы).
 *
 * После ADR-054 Phase D (KS-2645 / KS-2646) бэкенд держит единый
 * unified-эндпоинт прогресса:
 *
 *   POST /lessons/progress/lessons/:lessonId/step       — отметка шага
 *   POST /lessons/progress/lessons/:lessonId/complete   — завершение
 *
 * Хук работает одинаково для обоих типов курсов: lessonId передаётся в
 * URL, а бэк сам маршрутизирует в `LessonProgress` (system) или
 * `UserLessonProgress` (user) по типу курса.
 *
 * # Поведение
 * - Хранит локальный `stepsState: Record<stepId, LessonStepState>`.
 * - `markStep(stepId, state, score?)` — оптимистично обновляет state и
 *   ставит дебаунс-таск на отправку POST. Если за `DEBOUNCE_MS` приходит
 *   несколько `markStep` для одного и того же шага — отправится только
 *   последний.
 * - `completeLesson()` — проверяет, что доля «done» среди шагов
 *   ≥ `passThreshold` (по умолчанию 0.7), и в случае успеха дёргает POST
 *   complete с финальным `score`. Если порог не взят, возвращает
 *   `{ ok: false, ratio, threshold }` — API не дёргает.
 * - `score` — отношение «done» к общему количеству шагов (`totalSteps`).
 *
 * # Серверный seed прогресса
 *
 * Прогресс с сервера на момент монтирования передаётся через ОДИН из:
 *   - `initialProgress` — `UserLessonProgress` (system) с `stepsState`;
 *   - `initialStepsState` — голый Record (user, KS-1880), либо пусто.
 *
 * KS-1880: серверный `stepsState` в ответе на `markStep` мерджится в
 * локальный state, исключая те шаги, для которых есть pending-запросы
 * (чтобы свежие правки не затёрлись устаревшим snapshot'ом сервера).
 *
 * # Хук _не_ управляет загрузкой урока — это дело страницы.
 */

export const PASS_THRESHOLD = 0.7;
const DEBOUNCE_MS = 400;

interface UseLessonProgressOptions {
  /** UUID урока. `null` — пока урок не загружен (хук не отправит запросы). */
  lessonId: string | null;
  totalSteps: number;
  /**
   * Прогресс с сервера (системный курс) — `LessonWithStepsResponse.progress`.
   * Используется как seed `stepsState`. Для user-курсов передавай
   * `initialStepsState` напрямую.
   */
  initialProgress?: UserLessonProgress | null;
  /**
   * Альтернативный seed для user-курсов (KS-1880). Если задан вместе с
   * `initialProgress`, используется он (пользовательский имеет приоритет —
   * сервер user-progress хранит stepsState, system — производный).
   */
  initialStepsState?: Record<string, LessonStepState>;
  /** Порог «пройден» (0..1). По умолчанию 0.7. */
  passThreshold?: number;
}

export interface CompleteOutcome {
  ok: boolean;
  /** Доля done на момент попытки завершения. */
  ratio: number;
  /** Применённый порог. */
  threshold: number;
  /**
   * Серверный ответ при успехе. Для системных курсов — `CompleteLessonResponse`
   * (включая SM-2 поля для режима review). Для user-курсов backend возвращает
   * `UserCoursePlayProgressDto` без SM-2 полей — caller должен проверять
   * наличие нужных полей перед использованием.
   */
  progress?: CompleteLessonResponse | UserCoursePlayProgressDto;
  /** Ошибка сети, если попытка дошла до API и не прошла. */
  error?: Error;
}

/**
 * Параметры завершения урока. `quality` — SM-2 оценка 0..5, используется
 * в режиме review (L-22, KS-1799): 5 — «отлично», 3 — «с усилием»,
 * 0 — «не помню». Если не передан, бэк сам маппит из `score` в quality.
 * Для user-курсов поле игнорируется бэком.
 */
export interface CompleteLessonOptions {
  quality?: number;
}

export interface UseLessonProgressReturn {
  stepsState: Record<string, LessonStepState>;
  /** Доля «done» среди всех шагов. */
  score: number;
  /** Доля «done» в виде «X/Y». */
  doneCount: number;
  totalSteps: number;
  /** Порог «пройден». */
  threshold: number;
  /** Текущая попытка завершения в процессе. */
  isCompleting: boolean;
  /** Последняя ошибка отправки шагов (для логирования/баннера). */
  lastSyncError: Error | null;
  markStep: (stepId: string, state: LessonStepState, score?: number) => void;
  completeLesson: (options?: CompleteLessonOptions) => Promise<CompleteOutcome>;
  /**
   * Сброс локального `stepsState` к пустому (для режима review, L-22):
   * пользователь должен пройти все шаги заново, даже если они были done.
   */
  resetProgress: () => void;
}

function pickSeed(
  initialProgress?: UserLessonProgress | null,
  initialStepsState?: Record<string, LessonStepState>,
): Record<string, LessonStepState> {
  if (initialStepsState && Object.keys(initialStepsState).length > 0) {
    return initialStepsState;
  }
  return initialProgress?.stepsState ?? {};
}

export function useLessonProgress({
  lessonId,
  totalSteps,
  initialProgress,
  initialStepsState,
  passThreshold = PASS_THRESHOLD,
}: UseLessonProgressOptions): UseLessonProgressReturn {
  const [stepsState, setStepsState] = useState<Record<string, LessonStepState>>(
    () => pickSeed(initialProgress, initialStepsState),
  );
  const [isCompleting, setIsCompleting] = useState(false);
  const [lastSyncError, setLastSyncError] = useState<Error | null>(null);

  // При смене урока сбрасываем локальный state на серверный seed.
  // Сравниваем именно `lessonId` чтобы не затирать оптимистичные апдейты
  // при ре-рендерах того же самого урока.
  const seedRef = useRef<{ id: string | null }>({ id: lessonId });
  useEffect(() => {
    if (seedRef.current.id !== lessonId) {
      seedRef.current = { id: lessonId };
      setStepsState(pickSeed(initialProgress, initialStepsState));
      setLastSyncError(null);
    }
  }, [lessonId, initialProgress, initialStepsState]);

  // ─── Debounce-отправка шагов ───────────────────────────────────────
  const pendingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const pendingPayloadsRef = useRef<
    Map<string, { stepId: string; state: LessonStepState; score?: number }>
  >(new Map());

  // Отменяем все pending-таймеры при размонтировании / смене урока.
  useEffect(() => {
    const timers = pendingTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pendingPayloadsRef.current.clear();
    };
  }, [lessonId]);

  const flushStep = useCallback(
    async (stepId: string) => {
      const payload = pendingPayloadsRef.current.get(stepId);
      pendingPayloadsRef.current.delete(stepId);
      pendingTimersRef.current.delete(stepId);
      if (!payload || !lessonId) return;
      try {
        const response = await lessonsApi.markStep(lessonId, payload);
        // KS-1880: серверный `stepsState` — авторитативный. Мерджим
        // его поверх локального, ИСКЛЮЧАЯ те шаги, для которых сейчас
        // есть pending-запрос — иначе свежие локальные правки
        // затрутся устаревшим snapshot'ом сервера. Применимо и к
        // системным урокам после KS-2646: backend теперь стабильно
        // возвращает stepsState из обоих типов прогресса.
        const serverStepsState = response?.stepsState;
        if (serverStepsState && typeof serverStepsState === 'object') {
          setStepsState((prev) => {
            const next: Record<string, LessonStepState> = { ...prev };
            const pending = pendingPayloadsRef.current;
            let changed = false;
            for (const [sid, state] of Object.entries(serverStepsState)) {
              if (pending.has(sid)) continue;
              if (next[sid] !== state) {
                next[sid] = state as LessonStepState;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
        setLastSyncError(null);
      } catch (err) {
        // Сетевая ошибка не откатывает локальный state — пользователь
        // продолжает урок; ошибку показываем как баннер.
        setLastSyncError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [lessonId],
  );

  const markStep = useCallback(
    (stepId: string, state: LessonStepState, score?: number) => {
      setStepsState((prev) => {
        if (prev[stepId] === state) return prev;
        return { ...prev, [stepId]: state };
      });
      if (!lessonId) return;

      pendingPayloadsRef.current.set(stepId, { stepId, state, score });
      const existing = pendingTimersRef.current.get(stepId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        void flushStep(stepId);
      }, DEBOUNCE_MS);
      pendingTimersRef.current.set(stepId, timer);
    },
    [lessonId, flushStep],
  );

  // ─── Аггрегаты ─────────────────────────────────────────────────────
  const doneCount = useMemo(
    () => Object.values(stepsState).filter((s) => s === 'done').length,
    [stepsState],
  );
  const score = totalSteps > 0 ? doneCount / totalSteps : 0;

  // ─── completeLesson ────────────────────────────────────────────────
  const completeLesson = useCallback(
    async (options: CompleteLessonOptions = {}): Promise<CompleteOutcome> => {
      if (!lessonId) {
        return { ok: false, ratio: score, threshold: passThreshold };
      }
      if (score < passThreshold) {
        return { ok: false, ratio: score, threshold: passThreshold };
      }
      // Сначала «продавим» все pending-обновления шагов — иначе бэкенд
      // может посчитать урок не пройденным, если последний markStep не успел.
      const stepIds = Array.from(pendingTimersRef.current.keys());
      for (const id of stepIds) {
        const timer = pendingTimersRef.current.get(id);
        if (timer) clearTimeout(timer);
        await flushStep(id);
      }
      setIsCompleting(true);
      try {
        // Body — `{score, quality?}`. lessonId уже в URL (KS-2646 unified).
        const progress = await lessonsApi.completeLesson(lessonId, {
          // Отправляем lessonId на случай legacy-валидации; backend
          // для unified-эндпоинта URL-параметр имеет приоритет.
          lessonId,
          score,
          ...(options.quality !== undefined ? { quality: options.quality } : {}),
        });
        return { ok: true, ratio: score, threshold: passThreshold, progress };
      } catch (err) {
        return {
          ok: false,
          ratio: score,
          threshold: passThreshold,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      } finally {
        setIsCompleting(false);
      }
    },
    [lessonId, score, passThreshold, flushStep],
  );

  const resetProgress = useCallback(() => {
    // Отменяем pending-таймеры — иначе после reset они могут отправить
    // «done» старого шага уже после сброса.
    for (const timer of pendingTimersRef.current.values()) clearTimeout(timer);
    pendingTimersRef.current.clear();
    pendingPayloadsRef.current.clear();
    setStepsState({});
    setLastSyncError(null);
  }, []);

  return {
    resetProgress,
    stepsState,
    score,
    doneCount,
    totalSteps,
    threshold: passThreshold,
    isCompleting,
    lastSyncError,
    markStep,
    completeLesson,
  };
}
