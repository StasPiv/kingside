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
