import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLessonProgress, PASS_THRESHOLD } from './useLessonProgress';

// KS-2645: после слияния хуков прогресса (KS-2646 unified API)
// `useLessonProgress` зовёт `lessonsApi.markStep` (не `updateStep`).
// `updateStepAlias` оставлен как алиас на `markStep`, чтобы
// не переписывать существующие assertions.
const mockLessonsApi = {
  markStep: vi.fn(),
  completeLesson: vi.fn(),
};
const updateStepAlias = mockLessonsApi.markStep;

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: {
    markStep: (...args: unknown[]) => mockLessonsApi.markStep(...args),
    completeLesson: (...args: unknown[]) => mockLessonsApi.completeLesson(...args),
  },
}));

beforeEach(() => {
  mockLessonsApi.markStep.mockReset();
  mockLessonsApi.completeLesson.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLessonProgress', () => {
  it('markStep оптимистично обновляет stepsState и шлёт debounce-апдейт через 400мс', async () => {
    updateStepAlias.mockResolvedValue({});
    const { result } = renderHook(() =>
      useLessonProgress({ lessonId: 'l1', totalSteps: 1 }),
    );

    act(() => {
      result.current.markStep('s1', 'done');
    });
    expect(result.current.stepsState).toEqual({ s1: 'done' });
    // до 400мс — API не дёрнут
    expect(updateStepAlias).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(updateStepAlias).toHaveBeenCalledTimes(1);
    expect(updateStepAlias).toHaveBeenCalledWith('l1', {
      stepId: 's1',
      state: 'done',
      score: undefined,
    });
  });

  it('debounce: серия markStep по одному id отправляет ТОЛЬКО последний', async () => {
    updateStepAlias.mockResolvedValue({});
    const { result } = renderHook(() =>
      useLessonProgress({ lessonId: 'l1', totalSteps: 1 }),
    );

    act(() => {
      result.current.markStep('s1', 'in_progress');
      result.current.markStep('s1', 'done', 0.9);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(updateStepAlias).toHaveBeenCalledTimes(1);
    expect(updateStepAlias).toHaveBeenLastCalledWith('l1', {
      stepId: 's1',
      state: 'done',
      score: 0.9,
    });
  });

  it('сценарий «прошёл»: 3 из 3 done → completeLesson дёргает API, ok=true', async () => {
    updateStepAlias.mockResolvedValue({});
    mockLessonsApi.completeLesson.mockResolvedValue({
      userId: 'u1',
      lessonId: 'l1',
      startedAt: '2026-01-01',
      completedAt: '2026-01-02',
      score: 1,
      stepsState: { s1: 'done', s2: 'done', s3: 'done' },
    });

    const { result } = renderHook(() =>
      useLessonProgress({ lessonId: 'l1', totalSteps: 3 }),
    );

    act(() => {
      result.current.markStep('s1', 'done');
      result.current.markStep('s2', 'done');
      result.current.markStep('s3', 'done');
    });
    expect(result.current.score).toBe(1);
    expect(result.current.doneCount).toBe(3);

    let outcome: Awaited<ReturnType<typeof result.current.completeLesson>> | undefined;
    await act(async () => {
      const promise = result.current.completeLesson();
      // Прокручиваем pending-таймеры (flush в completeLesson await'ит каждый).
      await vi.advanceTimersByTimeAsync(0);
      outcome = await promise;
    });
    expect(outcome?.ok).toBe(true);
    expect(outcome?.ratio).toBe(1);
    expect(mockLessonsApi.completeLesson).toHaveBeenCalledWith('l1', { lessonId: 'l1', score: 1 });
  });

  it('сценарий «не хватило процента»: 1 из 3 done (33%) → completeLesson НЕ дёргает API, ok=false', async () => {
    updateStepAlias.mockResolvedValue({});
    const { result } = renderHook(() =>
      useLessonProgress({ lessonId: 'l1', totalSteps: 3 }),
    );

    act(() => {
      result.current.markStep('s1', 'done');
    });

    let outcome: Awaited<ReturnType<typeof result.current.completeLesson>> | undefined;
    await act(async () => {
      outcome = await result.current.completeLesson();
    });
    expect(outcome?.ok).toBe(false);
    expect(outcome?.ratio).toBeCloseTo(1 / 3, 5);
    expect(outcome?.threshold).toBe(PASS_THRESHOLD);
    expect(mockLessonsApi.completeLesson).not.toHaveBeenCalled();
  });

  it('сценарий «вернулся и добил»: после первого fail → отметить ещё шаги → второй completeLesson проходит', async () => {
    updateStepAlias.mockResolvedValue({});
    mockLessonsApi.completeLesson.mockResolvedValue({});

    const { result } = renderHook(() =>
      useLessonProgress({ lessonId: 'l1', totalSteps: 3 }),
    );

    // 1 из 3 → не хватает (33% < 70%)
    act(() => {
      result.current.markStep('s1', 'done');
    });
    let first: Awaited<ReturnType<typeof result.current.completeLesson>> | undefined;
    await act(async () => {
      first = await result.current.completeLesson();
    });
    expect(first?.ok).toBe(false);

    // Добил ещё один шаг → 2 из 3 = 67% — всё ещё мало
    act(() => {
      result.current.markStep('s2', 'done');
    });
    let second: Awaited<ReturnType<typeof result.current.completeLesson>> | undefined;
    await act(async () => {
      second = await result.current.completeLesson();
    });
    expect(second?.ok).toBe(false);
    expect(mockLessonsApi.completeLesson).not.toHaveBeenCalled();

    // Третий шаг → 100% → проходит
    act(() => {
      result.current.markStep('s3', 'done');
    });
    let third: Awaited<ReturnType<typeof result.current.completeLesson>> | undefined;
    await act(async () => {
      const p = result.current.completeLesson();
      await vi.advanceTimersByTimeAsync(0);
      third = await p;
    });
    expect(third?.ok).toBe(true);
    expect(mockLessonsApi.completeLesson).toHaveBeenCalledTimes(1);
    expect(mockLessonsApi.completeLesson).toHaveBeenCalledWith('l1', { lessonId: 'l1', score: 1 });
  });

  it('lastSyncError выставляется при сетевом сбое updateStep', async () => {
    updateStepAlias.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() =>
      useLessonProgress({ lessonId: 'l1', totalSteps: 1 }),
    );

    act(() => {
      result.current.markStep('s1', 'done');
    });
    // Прогоняем дебаунс + дожидаемся отклонения промиса flushStep.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      // Микрозадачи для catch-ветки.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.lastSyncError?.message).toBe('boom');
    // локальный state НЕ откачен
    expect(result.current.stepsState.s1).toBe('done');
  });

  it('initialProgress используется как seed stepsState', () => {
    const { result } = renderHook(() =>
      useLessonProgress({
        lessonId: 'l1',
        totalSteps: 2,
        initialProgress: {
          userId: 'u1',
          lessonId: 'l1',
          startedAt: '2026-01-01',
          completedAt: null,
          score: 0.5,
          stepsState: { s1: 'done', s2: 'in_progress' },
        },
      }),
    );
    expect(result.current.stepsState).toEqual({ s1: 'done', s2: 'in_progress' });
    expect(result.current.doneCount).toBe(1);
    expect(result.current.score).toBe(0.5);
  });

  it('кастомный passThreshold учитывается', async () => {
    const { result } = renderHook(() =>
      useLessonProgress({
        lessonId: 'l1',
        totalSteps: 4,
        passThreshold: 0.5,
      }),
    );
    act(() => {
      result.current.markStep('s1', 'done');
      result.current.markStep('s2', 'done');
    });
    expect(result.current.threshold).toBe(0.5);
    expect(result.current.score).toBe(0.5);
    let outcome: Awaited<ReturnType<typeof result.current.completeLesson>> | undefined;
    await act(async () => {
      outcome = await result.current.completeLesson();
    });
    expect(outcome?.ok).toBe(true);
  });
});
