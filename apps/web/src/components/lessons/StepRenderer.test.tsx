import { describe, it, expect, vi } from 'vitest';
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

vi.mock('./steps/GameReviewStep', () => ({
  GameReviewStep: ({ payload }: { payload: { gameId?: string; pgn?: string } }) => (
    <div
      data-testid="lesson-game-review-step-mock"
      data-game-id={payload.gameId ?? ''}
      data-pgn-len={String((payload.pgn ?? '').length)}
    />
  ),
}));

vi.mock('./steps/EndgameDrillStep', () => ({
  EndgameDrillStep: ({
    payload,
  }: {
    payload: { fen?: string; skillLevel?: number };
  }) => (
    <div
      data-testid="lesson-endgame-step-mock"
      data-fen={payload.fen ?? ''}
      data-skill={String(payload.skillLevel ?? '')}
    />
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

  it('делегирует endgame_drill-шаг компоненту EndgameDrillStep', () => {
    const step: LessonStep = {
      ...baseStep,
      type: 'endgame_drill',
      payload: {
        type: 'endgame_drill',
        fen: '8/8/8/8/4k3/8/3P4/3K4 w - - 0 1',
        playerSide: 'white',
        skillLevel: 5,
        winCondition: { kind: 'promote' },
      },
    };
    renderWithProviders(<StepRenderer step={step} />);
    expect(screen.getByTestId('lesson-endgame-step-mock')).toHaveAttribute(
      'data-skill',
      '5',
    );
  });

  it('делегирует game_review-шаг компоненту GameReviewStep', () => {
    const step: LessonStep = {
      ...baseStep,
      type: 'game_review',
      payload: { type: 'game_review', gameId: 'g123' },
    };
    renderWithProviders(<StepRenderer step={step} />);
    expect(
      screen.getByTestId('lesson-game-review-step-mock'),
    ).toHaveAttribute('data-game-id', 'g123');
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

  it('неизвестный тип шага → stepUnknown stub', () => {
    // Синтетический payload с неизвестным type — для покрытия default-ветки
    // exhaustive-check. LessonStep['type'] строго типизирован; приводим как
    // unknown для теста защиты от невалидных данных с бэка.
    const step = {
      ...baseStep,
      type: 'something-new',
      payload: { type: 'something-new' },
    } as unknown as LessonStep;
    renderWithProviders(<StepRenderer step={step} />);
    expect(
      screen.getByTestId('lesson-step-stub-unknown'),
    ).toBeInTheDocument();
  });
});
