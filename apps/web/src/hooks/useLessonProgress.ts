import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CompleteLessonResponse,
  LessonStepState,
  UpdateLessonStepRequest,
  UserLessonProgress,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';

/**
 * Хук прогресса урока (L-11, KS-1766).
 *
 * - Хранит локальный `stepsState: Record<stepId, LessonStepState>`.
 * - `markStep(stepId, state, score?)` — оптимистично обновляет state и
 *   ставит дебаунс-таск на отправку `POST /lessons/progress/step`.
 *   Если за `DEBOUNCE_MS` приходит несколько `markStep` для одного и
 *   того же шага — отправится только последний.
 * - `completeLesson()` — проверяет, что доля «done» среди шагов
 *   ≥ `passThreshold` (по умолчанию 0.7), и в случае успеха дёргает
 *   `POST /lessons/progress/lesson/<id>/complete` с финальным score.
 *   Если порог не взят, возвращает `{ ok: false, ratio, threshold }` —
 *   API не дёргает.
 * - `score` — отношение «done» к общему количеству шагов (`totalSteps`),
 *   нужно для индикатора прогресса в `LessonPage`.
 *
 * Серверный прогресс (если есть на момент монтирования) можно передать
 * через `initialProgress` — обычно это `LessonWithStepsResponse.progress`.
 *
 * Хук _не_ управляет самой загрузкой урока (это дело `LessonPage`).
 */

export const PASS_THRESHOLD = 0.7;
const DEBOUNCE_MS = 400;

interface UseLessonProgressOptions {
  lessonId: string | null;
  totalSteps: number;
  /** Прогресс с сервера, если есть. Используется как seed `stepsState`. */
  initialProgress?: UserLessonProgress | null;
  /** Порог «пройден» (0..1). По умолчанию 0.7. */
  passThreshold?: number;
}

export interface CompleteOutcome {
  ok: boolean;
  /** Доля done на момент попытки завершения. */
  ratio: number;
  /** Применённый порог. */
  threshold: number;
  /** Серверный ответ при успехе (включая SM-2 поля для режима review). */
  progress?: CompleteLessonResponse;
  /** Ошибка сети, если попытка дошла до API и не прошла. */
  error?: Error;
}

/**
 * Параметры завершения урока. `quality` — SM-2 оценка 0..5, используется
 * в режиме review (L-22, KS-1799): 5 — «отлично», 3 — «с усилием»,
 * 0 — «не помню». Если не передан, бэк сам маппит из `score` в quality.
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

export function useLessonProgress({
  lessonId,
  totalSteps,
  initialProgress,
  passThreshold = PASS_THRESHOLD,
}: UseLessonProgressOptions): UseLessonProgressReturn {
  const [stepsState, setStepsState] = useState<Record<string, LessonStepState>>(
    () => initialProgress?.stepsState ?? {},
  );
  const [isCompleting, setIsCompleting] = useState(false);
  const [lastSyncError, setLastSyncError] = useState<Error | null>(null);

  // При смене урока сбрасываем локальный state на серверный seed.
  // Сравниваем именно `lessonId` чтобы не затирать оптимистичные апдейты
  // при ре-рендерах того же самого урока.
  const seedRef = useRef<{ id: string | null; seed: Record<string, LessonStepState> }>({
    id: lessonId,
    seed: initialProgress?.stepsState ?? {},
  });
  useEffect(() => {
    if (seedRef.current.id !== lessonId) {
      seedRef.current = {
        id: lessonId,
        seed: initialProgress?.stepsState ?? {},
      };
      setStepsState(initialProgress?.stepsState ?? {});
      setLastSyncError(null);
    }
  }, [lessonId, initialProgress?.stepsState]);

  // ─── Debounce-отправка шагов ───────────────────────────────────────
  const pendingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const pendingPayloadsRef = useRef<Map<string, UpdateLessonStepRequest>>(
    new Map(),
  );

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
        await lessonsApi.updateStep(lessonId, payload);
        setLastSyncError(null);
      } catch (err) {
        // Сетевая ошибка не откатывает локальный state — пользователь
        // продолжает урок; ошибку показываем как баннер (опционально UI).
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
        // eslint-disable-next-line no-await-in-loop
        await flushStep(id);
      }
      setIsCompleting(true);
      try {
        const progress = await lessonsApi.completeLesson(lessonId, {
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
