import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  LessonStepState,
  UserLessonPlayProgressDto,
} from '@kingside/shared';

import { userCoursesApi } from '../api/userCoursesApi';

/**
 * Хук прогресса user-урока (ADR-026 §2.5, KS-1839 / FE-5).
 *
 * Аналог `useLessonProgress` для системных курсов, но бьёт в BE-4
 * endpoint'ы `/api/lessons/user-progress/*`:
 *  - `POST .../lessons/:userLessonId/step {stepId, state}` — отметка шага
 *  - `POST .../lessons/:userLessonId/complete {score}` — финальное
 *    завершение урока.
 *
 * Отличия от системного `useLessonProgress`:
 *  - SM-2 не подключён к user-курсам (ADR §2.1) → нет `quality`-поля.
 *  - Поле `stepsState` сервер пока не возвращает в `UserLessonPlayProgressDto`
 *    (ADR §2.1) — прогресс хранится агрегатно (`completedStepsCount`).
 *    Поэтому `initialStepsState` можно передавать извне, но по умолчанию
 *    хук стартует с пустого `{}`.
 *
 * Хук _не_ управляет самой загрузкой урока — это дело страницы.
 */

export const USER_LESSON_PASS_THRESHOLD = 0.7;
const DEBOUNCE_MS = 400;

interface UseUserLessonProgressOptions {
  userLessonId: string | null;
  totalSteps: number;
  initialStepsState?: Record<string, LessonStepState>;
  /** Порог «пройден» (0..1). По умолчанию 0.7 (ADR §2.6). */
  passThreshold?: number;
}

export interface UserLessonCompleteOutcome {
  ok: boolean;
  ratio: number;
  threshold: number;
  /** Серверный ответ при успехе. */
  progress?: UserLessonPlayProgressDto;
  error?: Error;
}

export interface UseUserLessonProgressReturn {
  stepsState: Record<string, LessonStepState>;
  score: number;
  doneCount: number;
  totalSteps: number;
  threshold: number;
  isCompleting: boolean;
  lastSyncError: Error | null;
  markStep: (stepId: string, state: LessonStepState) => void;
  completeLesson: () => Promise<UserLessonCompleteOutcome>;
  resetProgress: () => void;
}

export function useUserLessonProgress({
  userLessonId,
  totalSteps,
  initialStepsState,
  passThreshold = USER_LESSON_PASS_THRESHOLD,
}: UseUserLessonProgressOptions): UseUserLessonProgressReturn {
  const [stepsState, setStepsState] = useState<Record<string, LessonStepState>>(
    () => initialStepsState ?? {},
  );
  const [isCompleting, setIsCompleting] = useState(false);
  const [lastSyncError, setLastSyncError] = useState<Error | null>(null);

  // При смене урока сбрасываем локальный state на seed.
  const seedRef = useRef<{ id: string | null; seed: Record<string, LessonStepState> }>({
    id: userLessonId,
    seed: initialStepsState ?? {},
  });
  useEffect(() => {
    if (seedRef.current.id !== userLessonId) {
      seedRef.current = {
        id: userLessonId,
        seed: initialStepsState ?? {},
      };
      setStepsState(initialStepsState ?? {});
      setLastSyncError(null);
    }
  }, [userLessonId, initialStepsState]);

  // ── Debounced step sync ────────────────────────────────────────────
  const pendingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const pendingPayloadsRef = useRef<
    Map<string, { stepId: string; state: LessonStepState }>
  >(new Map());

  useEffect(() => {
    const timers = pendingTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pendingPayloadsRef.current.clear();
    };
  }, [userLessonId]);

  const flushStep = useCallback(
    async (stepId: string) => {
      const payload = pendingPayloadsRef.current.get(stepId);
      pendingPayloadsRef.current.delete(stepId);
      pendingTimersRef.current.delete(stepId);
      if (!payload || !userLessonId) return;
      try {
        const response = await userCoursesApi.updateStepProgress(
          userLessonId,
          payload,
        );
        // KS-1880: серверный `stepsState` — авторитативный (после
        // `KS-1879` BE отдаёт его в ответе на step-mutate). Мерджим
        // его поверх локального, ИСКЛЮЧАЯ те шаги, для которых сейчас
        // есть pending-запрос — иначе свежие локальные правки
        // затрутся устаревшим snapshot'ом сервера. На случай гонки
        // между клиентами это даёт нам новые состояния от других
        // сессий, не ломая текущий ввод пользователя.
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
        setLastSyncError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [userLessonId],
  );

  const markStep = useCallback(
    (stepId: string, state: LessonStepState) => {
      setStepsState((prev) => {
        if (prev[stepId] === state) return prev;
        return { ...prev, [stepId]: state };
      });
      if (!userLessonId) return;

      pendingPayloadsRef.current.set(stepId, { stepId, state });
      const existing = pendingTimersRef.current.get(stepId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        void flushStep(stepId);
      }, DEBOUNCE_MS);
      pendingTimersRef.current.set(stepId, timer);
    },
    [userLessonId, flushStep],
  );

  const doneCount = useMemo(
    () => Object.values(stepsState).filter((s) => s === 'done').length,
    [stepsState],
  );
  const score = totalSteps > 0 ? doneCount / totalSteps : 0;

  const completeLesson = useCallback(async (): Promise<UserLessonCompleteOutcome> => {
    if (!userLessonId) {
      return { ok: false, ratio: score, threshold: passThreshold };
    }
    if (score < passThreshold) {
      return { ok: false, ratio: score, threshold: passThreshold };
    }
    // Сначала продавим все pending-шаги, чтобы backend посчитал их как done.
    const stepIds = Array.from(pendingTimersRef.current.keys());
    for (const id of stepIds) {
      const timer = pendingTimersRef.current.get(id);
      if (timer) clearTimeout(timer);
      // eslint-disable-next-line no-await-in-loop
      await flushStep(id);
    }
    setIsCompleting(true);
    try {
      const progress = await userCoursesApi.completeLesson(userLessonId, {
        score,
      });
      // Backend отдаёт UserCoursePlayProgressDto (агрегат курса), но для
      // симметрии с системным useLessonProgress возвращаем урок-прогресс.
      // Cast допустим — outcome не читает course-специфичные поля.
      return {
        ok: true,
        ratio: score,
        threshold: passThreshold,
        progress: progress as unknown as UserLessonPlayProgressDto,
      };
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
  }, [userLessonId, score, passThreshold, flushStep]);

  const resetProgress = useCallback(() => {
    for (const timer of pendingTimersRef.current.values()) clearTimeout(timer);
    pendingTimersRef.current.clear();
    pendingPayloadsRef.current.clear();
    setStepsState({});
    setLastSyncError(null);
  }, []);

  return {
    stepsState,
    score,
    doneCount,
    totalSteps,
    threshold: passThreshold,
    isCompleting,
    lastSyncError,
    markStep,
    completeLesson,
    resetProgress,
  };
}
