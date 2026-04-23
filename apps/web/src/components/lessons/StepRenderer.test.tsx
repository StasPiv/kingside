import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import { StepRenderer } from './StepRenderer';
import type { LessonStep } from '@kingside/shared';

vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard" />,
}));

const baseStep = {
  id: 's1',
  lessonId: 'l1',
  order: 1,
};

describe('<StepRenderer>', () => {
  it('делегирует text-шаг компоненту TextStep', () => {
    const step: LessonStep = {
      ...baseStep,
      type: 'text',
      payload: { type: 'text', bodyMarkdown: 'Hello' },
    };
    renderWithProviders(<StepRenderer step={step} />);
    expect(screen.getByTestId('lesson-text-step')).toBeInTheDocument();
  });

  it.each([
    'puzzle',
    'quiz',
    'position',
    'game_review',
    'video',
  ] as const)(
    'для шага типа %s показывает stub с пометкой «coming soon»',
    (type) => {
      const step: LessonStep = {
        ...baseStep,
        type,
        // payload-форма различается, но для stub-рендера важен только type
        payload: { type } as LessonStep['payload'],
      };
      renderWithProviders(<StepRenderer step={step} />);
      expect(
        screen.getByTestId(`lesson-step-stub-${type}`),
      ).toBeInTheDocument();
    },
  );

  it('пробрасывает onStepDone в кнопку stub', () => {
    const onStepDone = vi.fn();
    const step: LessonStep = {
      ...baseStep,
      type: 'puzzle',
      payload: {
        type: 'puzzle',
        selection: { mode: 'ids', puzzleIds: [] },
      },
    };
    renderWithProviders(
      <StepRenderer step={step} onStepDone={onStepDone} />,
    );
    fireEvent.click(screen.getByTestId('lesson-step-stub-next'));
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('hideNext убирает кнопку у stub', () => {
    const step: LessonStep = {
      ...baseStep,
      type: 'quiz',
      payload: { type: 'quiz', questions: [] },
    };
    renderWithProviders(<StepRenderer step={step} hideNext />);
    expect(screen.queryByTestId('lesson-step-stub-next')).toBeNull();
  });
});
