import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../test/test-utils';
import { TextStep } from './TextStep';

/**
 * KS-1878 → KS-1990: text-only урок проходится явными кликами.
 *
 * До KS-1990 тут проверялся auto-done по таймеру (`TEXT_STEP_AUTO_DONE_MS`).
 * Сейчас прогресс растёт ТОЛЬКО когда пользователь нажимает «Далее».
 * Кнопка показана и на последнем шаге — `hideNext=true` для последнего
 * шага больше не передаётся (см. `LessonPage` / `UserLessonPage`).
 */

// KS-2645: после слияния хуков (ADR-054 Phase D) прогресс шага идёт
// через `lessonsApi.markStep` (unified POST). Мокаем только этот метод —
// для теста достаточно проверить что состояние шагов меняется.
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    markStep: vi.fn().mockResolvedValue({}),
    completeLesson: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../../api/lessonsApi', () => ({
  lessonsApi: apiMock,
}));

vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard" />,
}));

import { useLessonProgress } from '../../../hooks/useLessonProgress';

beforeEach(() => {
  apiMock.markStep.mockClear();
  apiMock.completeLesson.mockClear();
});

describe('text-only lesson flow (KS-1990)', () => {
  it('два text-шага: оба помечаются done только по клику «Далее»', async () => {
    const { result } = renderHook(() =>
      useLessonProgress({ lessonId: 'lesson-1', totalSteps: 2 }),
    );

    // Рендерим два TextStep'а — у обоих кнопка «Далее» (KS-1990 убрал
    // hideNext для последнего шага).
    renderWithProviders(
      <>
        <TextStep
          payload={{ type: 'text', bodyMarkdown: 'Step 1' }}
          onStepDone={() => result.current.markStep('s1', 'done')}
        />
        <TextStep
          payload={{ type: 'text', bodyMarkdown: 'Step 2 (last)' }}
          onStepDone={() => result.current.markStep('s2', 'done')}
        />
      </>,
    );

    // До любых кликов score = 0 (нет автомаркера KS-1990).
    expect(result.current.score).toBe(0);
    expect(result.current.score < result.current.threshold).toBe(true);

    const buttons = screen.getAllByTestId('lesson-text-step-next');
    expect(buttons).toHaveLength(2);

    // Первый клик → s1 done.
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    expect(result.current.stepsState.s1).toBe('done');
    expect(result.current.doneCount).toBe(1);

    // Второй клик → s2 done.
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    expect(result.current.doneCount).toBe(2);
    expect(result.current.score).toBe(1);
    expect(result.current.score >= result.current.threshold).toBe(true);
  });

  it('без клика — text-шаг остаётся pending (KS-1990 — нет автомаркера)', async () => {
    const { result } = renderHook(() =>
      useLessonProgress({ lessonId: 'lesson-2', totalSteps: 1 }),
    );

    renderWithProviders(
      <TextStep
        payload={{ type: 'text', bodyMarkdown: 'Theory' }}
        onStepDone={() => result.current.markStep('text-step', 'done')}
      />,
    );

    // Просто ждём «реального» времени — даже больше прежнего таймера.
    await new Promise((r) => setTimeout(r, 50));

    expect(result.current.doneCount).toBe(0);
    expect(result.current.stepsState['text-step']).toBeUndefined();
  });
});
