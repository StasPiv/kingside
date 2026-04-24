import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { MistakesPracticePage } from './MistakesPracticePage';

const mockLessonsApi = {
  getMistakeRecommendations: vi.fn(),
  resolvePuzzleStep: vi.fn(),
};

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: {
    getMistakeRecommendations: (...args: unknown[]) =>
      mockLessonsApi.getMistakeRecommendations(...args),
    resolvePuzzleStep: (...args: unknown[]) =>
      mockLessonsApi.resolvePuzzleStep(...args),
  },
}));

// PuzzleStep тянет chess.js / useAuth / PuzzleBoard — для теста страницы
// нас интересует только факт, что страница его рендерит с корректным payload.
vi.mock('../components/lessons/steps/PuzzleStep', () => ({
  PuzzleStep: ({
    payload,
  }: {
    payload: { selection?: { mode?: string; themes?: string[] } };
  }) => (
    <div
      data-testid="puzzle-step-mock"
      data-mode={payload.selection?.mode ?? ''}
      data-themes={(payload.selection?.themes ?? []).join(',')}
    />
  ),
}));

beforeEach(() => {
  mockLessonsApi.getMistakeRecommendations.mockReset();
});

describe('MistakesPracticePage (/lessons/mistakes-practice)', () => {
  it('без ?theme → пустое состояние + ссылка назад', async () => {
    renderWithProviders(<MistakesPracticePage />, {
      route: '/lessons/mistakes-practice',
    });
    expect(
      screen.getByTestId('mistakes-practice-empty'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('mistakes-practice-back')).toHaveAttribute(
      'href',
      '/lessons',
    );
    // API не дёргается
    expect(
      mockLessonsApi.getMistakeRecommendations,
    ).not.toHaveBeenCalled();
  });

  it('theme есть в recommendations → рендерит PuzzleStep с его payload', async () => {
    const puzzleStep = {
      type: 'puzzle' as const,
      selection: {
        mode: 'filter' as const,
        themes: ['fork'],
        ratingMin: 1000,
        ratingMax: 1400,
        limit: 10,
      },
    };
    mockLessonsApi.getMistakeRecommendations.mockResolvedValueOnce({
      recommendations: [
        {
          theme: 'fork',
          mistakeCount: 8,
          lastOccurredAt: '2026-04-22T00:00:00.000Z',
          puzzleStep,
        },
      ],
      ratingPuzzle: 1200,
      windowDays: 30,
      ratingRange: 200,
    });

    renderWithProviders(<MistakesPracticePage />, {
      route: '/lessons/mistakes-practice?theme=fork',
    });

    await waitFor(() =>
      expect(screen.getByTestId('mistakes-practice-page')).toHaveAttribute(
        'data-theme',
        'fork',
      ),
    );

    expect(screen.getByTestId('puzzle-step-mock')).toHaveAttribute(
      'data-mode',
      'filter',
    );
    expect(screen.getByTestId('puzzle-step-mock')).toHaveAttribute(
      'data-themes',
      'fork',
    );
  });

  it('theme отсутствует в recommendations → дружелюбная заглушка', async () => {
    mockLessonsApi.getMistakeRecommendations.mockResolvedValueOnce({
      recommendations: [],
      ratingPuzzle: 1200,
      windowDays: 30,
      ratingRange: 200,
    });

    renderWithProviders(<MistakesPracticePage />, {
      route: '/lessons/mistakes-practice?theme=fork',
    });

    await waitFor(() =>
      expect(
        screen.getByTestId('mistakes-practice-not-found'),
      ).toBeInTheDocument(),
    );
  });

  it('сетевая ошибка → сообщение об ошибке', async () => {
    mockLessonsApi.getMistakeRecommendations.mockRejectedValueOnce(
      new Error('boom'),
    );
    renderWithProviders(<MistakesPracticePage />, {
      route: '/lessons/mistakes-practice?theme=fork',
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('mistakes-practice-error'),
      ).toBeInTheDocument(),
    );
  });
});
