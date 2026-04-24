import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import { StepRenderer } from './StepRenderer';
import type { LessonStep } from '@kingside/shared';

vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard" />,
}));

// PuzzleStep тянет PuzzleBoard / chess.js / useAuth — для unit-теста
// диспетчера это лишний шум; мокаем сам PuzzleStep на лёгкую заглушку.
vi.mock('./steps/PuzzleStep', () => ({
  PuzzleStep: ({ payload }: { payload: { selection?: { puzzleIds?: string[] } } }) => (
    <div
      data-testid="lesson-puzzle-step-mock"
      data-ids={payload.selection?.puzzleIds?.join(',') ?? ''}
    />
  ),
}));

vi.mock('./steps/QuizStep', () => ({
  QuizStep: ({ payload }: { payload: { questions?: Array<{ id: string }> } }) => (
    <div
      data-testid="lesson-quiz-step-mock"
      data-count={payload.questions?.length ?? 0}
    />
  ),
}));

vi.mock('./steps/PositionStep', () => ({
  PositionStep: ({ payload }: { payload: { fen?: string; expectedMoves?: string[] } }) => (
    <div
      data-testid="lesson-position-step-mock"
      data-fen={payload.fen ?? ''}
      data-expected={payload.expectedMoves?.join(',') ?? ''}
    />
  ),
}));

vi.mock('./steps/VideoStep', () => ({
  VideoStep: ({ payload }: { payload: { url?: string } }) => (
    <div data-testid="lesson-video-step-mock" data-url={payload.url ?? ''} />
  ),
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

  it('для шага типа game_review показывает stub с пометкой «coming soon»', () => {
    const step: LessonStep = {
      ...baseStep,
      type: 'game_review',
      payload: { type: 'game_review' } as LessonStep['payload'],
    };
    renderWithProviders(<StepRenderer step={step} />);
    expect(
      screen.getByTestId('lesson-step-stub-game_review'),
    ).toBeInTheDocument();
  });

  it('делегирует video-шаг компоненту VideoStep', () => {
    const step: LessonStep = {
      ...baseStep,
      type: 'video',
      payload: {
        type: 'video',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      },
    };
    renderWithProviders(<StepRenderer step={step} />);
    expect(screen.getByTestId('lesson-video-step-mock')).toHaveAttribute(
      'data-url',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
  });

  it('делегирует position-шаг компоненту PositionStep', () => {
    const step: LessonStep = {
      ...baseStep,
      type: 'position',
      payload: {
        type: 'position',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        expectedMoves: ['e2e4', 'd2d4'],
      },
    };
    renderWithProviders(<StepRenderer step={step} />);
    const node = screen.getByTestId('lesson-position-step-mock');
    expect(node).toHaveAttribute('data-expected', 'e2e4,d2d4');
  });

  it('делегирует puzzle-шаг компоненту PuzzleStep', () => {
    const step: LessonStep = {
      ...baseStep,
      type: 'puzzle',
      payload: {
        type: 'puzzle',
        selection: { mode: 'ids', puzzleIds: ['p1', 'p2'] },
      },
    };
    renderWithProviders(<StepRenderer step={step} />);
    const node = screen.getByTestId('lesson-puzzle-step-mock');
    expect(node).toHaveAttribute('data-ids', 'p1,p2');
  });

  it('делегирует quiz-шаг компоненту QuizStep', () => {
    const step: LessonStep = {
      ...baseStep,
      type: 'quiz',
      payload: {
        type: 'quiz',
        questions: [
          { id: 'q1', promptI18nKey: 'k1', options: [], correctOptionIds: [] },
          { id: 'q2', promptI18nKey: 'k2', options: [], correctOptionIds: [] },
        ],
      },
    };
    renderWithProviders(<StepRenderer step={step} />);
    expect(screen.getByTestId('lesson-quiz-step-mock')).toHaveAttribute(
      'data-count',
      '2',
    );
  });

  it('пробрасывает onStepDone в кнопку stub (game_review)', () => {
    const onStepDone = vi.fn();
    const step: LessonStep = {
      ...baseStep,
      type: 'game_review',
      payload: { type: 'game_review' } as LessonStep['payload'],
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
      type: 'game_review',
      payload: { type: 'game_review' } as LessonStep['payload'],
    };
    renderWithProviders(<StepRenderer step={step} hideNext />);
    expect(screen.queryByTestId('lesson-step-stub-next')).toBeNull();
  });
});
