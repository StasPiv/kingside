import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * KS-1839 (FE-5): тесты `useUserLessonProgress`.
 *
 * Покрытие:
 *  - markStep: debounced POST /user-progress/lessons/:id/step с payload
 *  - completeLesson: порог 0.7 соблюдается; ниже — `ok:false`, без запроса
 *  - completeLesson: при успехе flush'ит pending-шаги до complete
 *  - score/doneCount считаются корректно
 *  - смена userLessonId сбрасывает локальный state
 *  - resetProgress очищает всё
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    updateStepProgress: vi.fn(),
    completeLesson: vi.fn(),
  },
}));

vi.mock('../api/userCoursesApi', () => ({
  userCoursesApi: apiMock,
}));

import { useUserLessonProgress } from './useUserLessonProgress';

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.updateStepProgress.mockReset();
  apiMock.completeLesson.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useUserLessonProgress', () => {
  it('markStep → оптимистичный state + debounced POST через ~400мс', async () => {
    apiMock.updateStepProgress.mockResolvedValue({});
    const { result } = renderHook(() =>
      useUserLessonProgress({ userLessonId: 'l1', totalSteps: 2 }),
    );

    act(() => {
      result.current.markStep('s1', 'done');
    });
    expect(result.current.stepsState).toEqual({ s1: 'done' });

    // 300мс — ещё не выстрелил.
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(apiMock.updateStepProgress).not.toHaveBeenCalled();

    // 400мс — выстрелил один раз.
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(apiMock.updateStepProgress).toHaveBeenCalledWith('l1', {
      stepId: 's1',
      state: 'done',
    });
  });

  it('markStep дважды быстро → один POST с последним state', async () => {
    apiMock.updateStepProgress.mockResolvedValue({});
    const { result } = renderHook(() =>
      useUserLessonProgress({ userLessonId: 'l1', totalSteps: 1 }),
    );

    act(() => {
      result.current.markStep('s1', 'done');
    });
    act(() => {
      result.current.markStep('s1', 'failed');
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(apiMock.updateStepProgress).toHaveBeenCalledTimes(1);
    expect(apiMock.updateStepProgress).toHaveBeenCalledWith('l1', {
      stepId: 's1',
      state: 'failed',
    });
  });

  it('score считается как доля done от totalSteps', () => {
    const { result } = renderHook(() =>
      useUserLessonProgress({ userLessonId: 'l1', totalSteps: 4 }),
    );
    act(() => {
      result.current.markStep('a', 'done');
      result.current.markStep('b', 'done');
      result.current.markStep('c', 'failed');
    });
    expect(result.current.doneCount).toBe(2);
    expect(result.current.score).toBe(0.5);
  });

  it('completeLesson: score < threshold → ok:false, без POST complete', async () => {
    const { result } = renderHook(() =>
      useUserLessonProgress({ userLessonId: 'l1', totalSteps: 10 }),
    );
    act(() => {
      // 3/10 = 0.3 < 0.7
      result.current.markStep('a', 'done');
      result.current.markStep('b', 'done');
      result.current.markStep('c', 'done');
    });

    let outcome: Awaited<ReturnType<typeof result.current.completeLesson>> | null = null;
    await act(async () => {
      outcome = await result.current.completeLesson();
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.ok).toBe(false);
    expect(outcome!.ratio).toBeCloseTo(0.3);
    expect(apiMock.completeLesson).not.toHaveBeenCalled();
  });

  it('completeLesson: score >= threshold → flush pending + POST complete', async () => {
    apiMock.updateStepProgress.mockResolvedValue({});
    apiMock.completeLesson.mockResolvedValue({
      userCourseId: 'c1',
      completedLessonsCount: 1,
      startedAt: 'x',
      lastActivityAt: 'x',
      completedAt: null,
    });

    const { result } = renderHook(() =>
      useUserLessonProgress({ userLessonId: 'l1', totalSteps: 2 }),
    );
    act(() => {
      result.current.markStep('a', 'done');
      result.current.markStep('b', 'done');
    });

    let outcome: Awaited<ReturnType<typeof result.current.completeLesson>> | null = null;
    await act(async () => {
      outcome = await result.current.completeLesson();
    });

    // Pending-шаги должны быть flush'ены до complete.
    expect(apiMock.updateStepProgress).toHaveBeenCalledWith('l1', { stepId: 'a', state: 'done' });
    expect(apiMock.updateStepProgress).toHaveBeenCalledWith('l1', { stepId: 'b', state: 'done' });
    expect(apiMock.completeLesson).toHaveBeenCalledWith('l1', { score: 1 });
    expect(outcome!.ok).toBe(true);
    expect(outcome!.ratio).toBe(1);
  });

  it('смена userLessonId сбрасывает локальный state', () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useUserLessonProgress({ userLessonId: id, totalSteps: 2 }),
      { initialProps: { id: 'l1' } },
    );
    act(() => {
      result.current.markStep('a', 'done');
    });
    expect(result.current.stepsState).toEqual({ a: 'done' });

    rerender({ id: 'l2' });
    expect(result.current.stepsState).toEqual({});
  });

  it('resetProgress очищает state и таймеры', () => {
    const { result } = renderHook(() =>
      useUserLessonProgress({ userLessonId: 'l1', totalSteps: 1 }),
    );
    act(() => {
      result.current.markStep('a', 'done');
    });
    act(() => {
      result.current.resetProgress();
    });
    expect(result.current.stepsState).toEqual({});
    // И таймер снят: advance не вызовет API.
    vi.advanceTimersByTime(1000);
    expect(apiMock.updateStepProgress).not.toHaveBeenCalled();
  });
});

/**
 * KS-1880: восстановление stepsState из сервера при первом открытии
 * урока. Без фикса хук всегда стартовал с {}, и завершённые уроки
 * показывали 0% / все шаги pending.
 */
describe('useUserLessonProgress · initial stepsState (KS-1880)', () => {
  it('инициализируется с переданным initialStepsState — score сразу не нулевой', () => {
    const { result } = renderHook(() =>
      useUserLessonProgress({
        userLessonId: 'l1',
        totalSteps: 3,
        initialStepsState: { a: 'done', b: 'done', c: 'pending' },
      }),
    );
    expect(result.current.stepsState).toEqual({
      a: 'done',
      b: 'done',
      c: 'pending',
    });
    expect(result.current.doneCount).toBe(2);
    expect(result.current.score).toBeCloseTo(2 / 3);
  });

  it('завершённый урок (все done) — score = 1, выше threshold', () => {
    const { result } = renderHook(() =>
      useUserLessonProgress({
        userLessonId: 'l1',
        totalSteps: 2,
        initialStepsState: { a: 'done', b: 'done' },
      }),
    );
    expect(result.current.score).toBe(1);
    expect(result.current.score >= result.current.threshold).toBe(true);
  });

  it('сервер вернул пустой stepsState (никогда не открывал) → state = {} / score = 0', () => {
    const { result } = renderHook(() =>
      useUserLessonProgress({
        userLessonId: 'l1',
        totalSteps: 3,
        initialStepsState: undefined,
      }),
    );
    expect(result.current.stepsState).toEqual({});
    expect(result.current.score).toBe(0);
  });

  it('смена userLessonId с новым initialStepsState → state перечитан', () => {
    const { result, rerender } = renderHook(
      ({ id, seed }: { id: string; seed?: Record<string, 'done' | 'pending'> }) =>
        useUserLessonProgress({
          userLessonId: id,
          totalSteps: 2,
          initialStepsState: seed,
        }),
      {
        initialProps: { id: 'l1', seed: { a: 'done', b: 'done' } as Record<string, 'done' | 'pending'> },
      },
    );
    expect(result.current.stepsState).toEqual({ a: 'done', b: 'done' });

    rerender({ id: 'l2', seed: { x: 'pending' } });
    expect(result.current.stepsState).toEqual({ x: 'pending' });
    expect(result.current.score).toBe(0);
  });

  it('flushStep мерджит response.stepsState поверх локального — авторитативный сервер', async () => {
    apiMock.updateStepProgress.mockResolvedValue({
      userLessonId: 'l1',
      completedStepsCount: 2,
      totalSteps: 3,
      // server: a уже done, и помимо нашего step'а b добавился c (другой клиент)
      stepsState: { a: 'done', b: 'done', c: 'done' },
      startedAt: 'x',
      lastActivityAt: 'x',
      completedAt: null,
    });

    const { result } = renderHook(() =>
      useUserLessonProgress({
        userLessonId: 'l1',
        totalSteps: 3,
        initialStepsState: { a: 'done' },
      }),
    );
    act(() => {
      result.current.markStep('b', 'done');
    });
    expect(result.current.stepsState).toEqual({ a: 'done', b: 'done' });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    // После flush — серверный c подхватился, локальные тоже целы.
    expect(result.current.stepsState).toEqual({
      a: 'done',
      b: 'done',
      c: 'done',
    });
  });

  it('flushStep НЕ затирает pending-локальные правки серверным snapshot', async () => {
    // Сервер ответит на первый flush с состоянием БЕЗ b (старый snapshot
    // до того, как мы успели b отправить). Локальный state с b должен
    // сохраниться, т.к. b сейчас pending в очереди.
    apiMock.updateStepProgress.mockImplementation(async (_id: string, payload: { stepId: string; state: string }) => ({
      userLessonId: 'l1',
      completedStepsCount: payload.stepId === 'a' ? 1 : 2,
      totalSteps: 3,
      stepsState: payload.stepId === 'a' ? { a: 'done' } : { a: 'done', b: 'done' },
      startedAt: 'x',
      lastActivityAt: 'x',
      completedAt: null,
    }));

    const { result } = renderHook(() =>
      useUserLessonProgress({ userLessonId: 'l1', totalSteps: 3 }),
    );
    act(() => {
      result.current.markStep('a', 'done');
    });
    // Имитируем гонку: ещё одна локальная правка пока первая в полёте.
    act(() => {
      result.current.markStep('b', 'done');
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    // b остался — он либо ещё pending (и сохранён), либо тоже flushнут
    // и сервер вернул {a, b}.
    expect(result.current.stepsState.a).toBe('done');
    expect(result.current.stepsState.b).toBe('done');
  });
});
