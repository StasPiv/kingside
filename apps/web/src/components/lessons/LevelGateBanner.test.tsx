import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { LevelGateBanner } from './LevelGateBanner';

const mockLessonsApi = {
  getLevelGate: vi.fn(),
};

vi.mock('../../api/lessonsApi', () => ({
  lessonsApi: {
    getLevelGate: (...args: unknown[]) => mockLessonsApi.getLevelGate(...args),
  },
}));

beforeEach(() => {
  mockLessonsApi.getLevelGate.mockReset();
});

describe('<LevelGateBanner>', () => {
  it('unlocked=true → плашка «Можно перейти»', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'beginner',
      nextLevel: 'intermediate',
      unlocked: true,
      blockers: [],
    });
    renderWithProviders(<LevelGateBanner />);
    await waitFor(() =>
      expect(screen.getByTestId('level-gate')).toHaveAttribute('data-state', 'unlocked'),
    );
    expect(screen.getByTestId('level-gate')).toHaveTextContent('Intermediate');
    expect(screen.getByTestId('level-gate')).toHaveTextContent('All requirements met');
  });

  it('blocker course_not_completed → «Lessons remaining: N»', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'beginner',
      nextLevel: 'intermediate',
      unlocked: false,
      blockers: [{ kind: 'course_not_completed', lessonsRemaining: 3 }],
    });
    renderWithProviders(<LevelGateBanner />);
    await waitFor(() =>
      expect(
        screen.getByTestId('level-gate-blocker-course_not_completed'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('level-gate-blocker-course_not_completed'),
    ).toHaveTextContent('Lessons remaining: 3');
    expect(screen.getByTestId('level-gate')).toHaveAttribute('data-state', 'locked');
  });

  it('blocker puzzle_rating → «Puzzle rating: current/required»', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'beginner',
      nextLevel: 'intermediate',
      unlocked: false,
      blockers: [{ kind: 'puzzle_rating', current: 1100, required: 1200 }],
    });
    renderWithProviders(<LevelGateBanner />);
    await waitFor(() =>
      expect(
        screen.getByTestId('level-gate-blocker-puzzle_rating'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('level-gate-blocker-puzzle_rating'),
    ).toHaveTextContent('Puzzle rating: 1100/1200');
  });

  it('blocker games_played → «Games played: current/required»', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'beginner',
      nextLevel: 'intermediate',
      unlocked: false,
      blockers: [{ kind: 'games_played', current: 7, required: 20 }],
    });
    renderWithProviders(<LevelGateBanner />);
    await waitFor(() =>
      expect(
        screen.getByTestId('level-gate-blocker-games_played'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('level-gate-blocker-games_played'),
    ).toHaveTextContent('Games played: 7/20');
  });

  it('несколько блокеров рендерятся в порядке прихода', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'beginner',
      nextLevel: 'intermediate',
      unlocked: false,
      blockers: [
        { kind: 'course_not_completed', lessonsRemaining: 1 },
        { kind: 'puzzle_rating', current: 1100, required: 1200 },
        { kind: 'games_played', current: 0, required: 20 },
      ],
    });
    renderWithProviders(<LevelGateBanner />);
    await waitFor(() =>
      expect(screen.getByTestId('level-gate')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('level-gate-blocker-course_not_completed'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('level-gate-blocker-puzzle_rating'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('level-gate-blocker-games_played'),
    ).toBeInTheDocument();
  });

  it('nextLevel=null (advanced) → ничего не рендерим', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'advanced',
      nextLevel: null,
      unlocked: false,
      blockers: [],
    });
    const { container } = renderWithProviders(<LevelGateBanner />);
    await waitFor(() =>
      expect(mockLessonsApi.getLevelGate).toHaveBeenCalled(),
    );
    expect(container.querySelector('[data-testid="level-gate"]')).toBeNull();
  });

  it('restrictTo не совпадает с currentLevel → ничего не рендерим', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'intermediate',
      nextLevel: 'advanced',
      unlocked: true,
      blockers: [],
    });
    const { container } = renderWithProviders(<LevelGateBanner restrictTo="beginner" />);
    await waitFor(() =>
      expect(mockLessonsApi.getLevelGate).toHaveBeenCalled(),
    );
    expect(container.querySelector('[data-testid="level-gate"]')).toBeNull();
  });

  it('сетевая ошибка → плашка скрывается, страница не ломается', async () => {
    mockLessonsApi.getLevelGate.mockRejectedValueOnce(new Error('boom'));
    const { container } = renderWithProviders(<LevelGateBanner />);
    await waitFor(() =>
      expect(mockLessonsApi.getLevelGate).toHaveBeenCalled(),
    );
    expect(container.querySelector('[data-testid="level-gate"]')).toBeNull();
  });
});
