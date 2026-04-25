import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../test/test-utils';
import { TextStep, TEXT_STEP_AUTO_DONE_MS } from './TextStep';

/**
 * KS-1878: интеграционный smoke на сценарий «text-only урок проходим
 * через UI».
 *
 * Симулируем то, что делает `UserLessonPage`:
 *  - инициализирует `useUserLessonProgress` с `totalSteps = N`,
 *  - рендерит N штук `<TextStep>` с `onStepDone={() => markStep(id, 'done')}`,
 *  - последний шаг получает `hideNext=true`.
 *
 * До фикса последний шаг не имел кнопки и не маркировался → score
 * замирал на (N-1)/N. С авто-done через `TEXT_STEP_AUTO_DONE_MS` все
 * шаги доходят до done и `score >= threshold (0.7)`.
 *
 * Хук замокан, чтобы не звать сетевой API; нас интересует логика
 * `markStep` / `score` / `threshold`.
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    updateStepProgress: vi.fn().mockResolvedValue({}),
    completeLesson: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../../api/userCoursesApi', () => ({
  userCoursesApi: apiMock,
}));

vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard" />,
}));

import { useUserLessonProgress } from '../../../hooks/useUserLessonProgress';

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.updateStepProgress.mockClear();
  apiMock.completeLesson.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('text-only lesson flow (KS-1878)', () => {
  it('два text-шага: оба авто-помечаются done, score >= threshold, complete доступен', async () => {
    const { result } = renderHook(() =>
      useUserLessonProgress({ userLessonId: 'lesson-1', totalSteps: 2 }),
    );

    // Рендерим два TextStep'а (как в UserLessonPage). Последний — с hideNext.
    renderWithProviders(
      <>
        <TextStep
          payload={{ type: 'text', bodyMarkdown: 'Step 1' }}
          onStepDone={() => result.current.markStep('s1', 'done')}
        />
        <TextStep
          payload={{ type: 'text', bodyMarkdown: 'Step 2 (last)' }}
          onStepDone={() => result.current.markStep('s2', 'done')}
          hideNext
        />
      </>,
    );

    // Ни у одного шага нет интерактива в этой связке (s2 — без кнопки;
    // s1 имеет кнопку, но мы её не нажимаем — авто-done должен работать).
    expect(screen.queryByTestId('lesson-text-step-next')).not.toBeNull(); // у s1 кнопка есть
    expect(result.current.score).toBe(0);
    expect(result.current.score < result.current.threshold).toBe(true);

    // Прогоняем таймер авто-done. Оба шага должны помечаться.
    await act(async () => {
      vi.advanceTimersByTime(TEXT_STEP_AUTO_DONE_MS + 1);
    });

    expect(result.current.doneCount).toBe(2);
    expect(result.current.score).toBe(1);
    expect(result.current.score >= result.current.threshold).toBe(true);
  });

  it('Регрессия: смешанный урок (text + non-text) не сломан — text авто-помечается, non-text руками', async () => {
    const { result } = renderHook(() =>
      useUserLessonProgress({ userLessonId: 'lesson-2', totalSteps: 2 }),
    );

    // Рендерим только text-шаг (puzzle симулируем вручную — это unit, не e2e).
    renderWithProviders(
      <TextStep
        payload={{ type: 'text', bodyMarkdown: 'Theory' }}
        onStepDone={() => result.current.markStep('text-step', 'done')}
      />,
    );

    // text авто-помечается.
    await act(async () => {
      vi.advanceTimersByTime(TEXT_STEP_AUTO_DONE_MS + 1);
    });
    expect(result.current.stepsState['text-step']).toBe('done');
    expect(result.current.score).toBe(0.5);
    expect(result.current.score < result.current.threshold).toBe(true);

    // puzzle решается отдельно (имитируем).
    act(() => {
      result.current.markStep('puzzle-step', 'done');
    });
    expect(result.current.score).toBe(1);
    expect(result.current.score >= result.current.threshold).toBe(true);
  });
});
