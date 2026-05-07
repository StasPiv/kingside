import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { PuzzleMistakesPracticePage } from './PuzzleMistakesPracticePage';

/**
 * KS-1928: страница тренировки по теме `/puzzles/mistakes-practice?theme=<...>`.
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: { getAggregates: vi.fn(), getRecommendations: vi.fn() },
}));

vi.mock('../api/puzzleMistakesApi', () => ({
  puzzleMistakesApi: apiMock,
}));

// PuzzleStep тяжёлый — мокаем чтобы не тащить шахматную логику.
vi.mock('../components/lessons/steps/PuzzleStep', () => ({
  PuzzleStep: () => <div data-testid="puzzle-step-mock" />,
}));

beforeEach(() => {
  apiMock.getRecommendations.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<PuzzleMistakesPracticePage>', () => {
  it('без theme в query → empty state + back-link на /puzzles', () => {
    renderWithProviders(<PuzzleMistakesPracticePage />, {
      route: '/puzzles/mistakes-practice',
    });
    expect(screen.getByTestId('mistakes-practice-empty')).toBeInTheDocument();
    expect(screen.getByTestId('mistakes-practice-back')).toHaveAttribute(
      'href',
      '/puzzles',
    );
  });

  it('loading state при наличии theme', () => {
    apiMock.getRecommendations.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<PuzzleMistakesPracticePage />, {
      route: '/puzzles/mistakes-practice?theme=fork',
    });
    expect(screen.getByTestId('mistakes-practice-loading')).toBeInTheDocument();
  });

  it('тема найдена в recommendations → рендерит PuzzleStep', async () => {
    apiMock.getRecommendations.mockResolvedValueOnce({
      recommendations: [
        {
          theme: 'fork',
          mistakeCount: 5,
          puzzleStep: { type: 'puzzle', selection: { mode: 'filter' } },
        },
      ],
      windowDays: 30,
      ratingPuzzle: 1500,
      ratingRange: { min: 1300, max: 1700 },
    });
    renderWithProviders(<PuzzleMistakesPracticePage />, {
      route: '/puzzles/mistakes-practice?theme=fork',
    });
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-practice-page')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('puzzle-step-mock')).toBeInTheDocument();
  });

  it('тема не в recommendations → not-found state + back-link на /puzzles', async () => {
    apiMock.getRecommendations.mockResolvedValueOnce({
      recommendations: [],
      windowDays: 30,
      ratingPuzzle: 1500,
      ratingRange: { min: 1300, max: 1700 },
    });
    renderWithProviders(<PuzzleMistakesPracticePage />, {
      route: '/puzzles/mistakes-practice?theme=missing',
    });
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-practice-not-found')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mistakes-practice-back')).toHaveAttribute(
      'href',
      '/puzzles',
    );
  });

  it('error → error state', async () => {
    apiMock.getRecommendations.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<PuzzleMistakesPracticePage />, {
      route: '/puzzles/mistakes-practice?theme=fork',
    });
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-practice-error')).toBeInTheDocument(),
    );
  });

  // KS-2497 (ADR-046 §5.7): legacy-ссылка с playVsEngine редиректит на
  // /puzzles/play-vs-engine. Тест через `Routes` — после Navigate
  // MemoryRouter показывает контент целевой страницы.
  it('KS-2497: theme=playVsEngine → редирект на /puzzles/play-vs-engine', () => {
    renderWithProviders(
      <Routes>
        <Route
          path="/puzzles/mistakes-practice"
          element={<PuzzleMistakesPracticePage />}
        />
        <Route
          path="/puzzles/play-vs-engine"
          element={<div data-testid="play-vs-engine-stub">play-vs-engine page</div>}
        />
      </Routes>,
      { route: '/puzzles/mistakes-practice?theme=playVsEngine' },
    );
    // После Navigate MemoryRouter рендерит совпавший роут.
    expect(screen.getByTestId('play-vs-engine-stub')).toBeInTheDocument();
    // Старая страница НЕ рендерится.
    expect(screen.queryByTestId('mistakes-practice-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mistakes-practice-empty')).not.toBeInTheDocument();
    // API не дёргался — early-return.
    expect(apiMock.getRecommendations).not.toHaveBeenCalled();
  });
});
