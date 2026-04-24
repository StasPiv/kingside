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

  // ─── L-26 (KS-1804): переход intermediate → advanced ─────────────────

  it('intermediate → advanced: unlocked=true → «Можно перейти на опытный»', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'intermediate',
      nextLevel: 'advanced',
      unlocked: true,
      blockers: [],
    });
    renderWithProviders(<LevelGateBanner from="intermediate" />);
    await waitFor(() =>
      expect(screen.getByTestId('level-gate')).toHaveAttribute(
        'data-state',
        'unlocked',
      ),
    );
    // Fallback-строка `lessons.level.advanced` → «Advanced» (en).
    expect(screen.getByTestId('level-gate')).toHaveTextContent('Advanced');
    expect(screen.getByTestId('level-gate')).toHaveTextContent(
      'All requirements met',
    );
  });

  it('blocker rapid_rating → «Rapid rating: current/required»', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'intermediate',
      nextLevel: 'advanced',
      unlocked: false,
      blockers: [{ kind: 'rapid_rating', current: 1350, required: 1400 }],
    });
    renderWithProviders(<LevelGateBanner from="intermediate" />);
    await waitFor(() =>
      expect(
        screen.getByTestId('level-gate-blocker-rapid_rating'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('level-gate-blocker-rapid_rating'),
    ).toHaveTextContent('Rapid rating: 1350/1400');
  });

  it('blocker puzzles_solved → «Puzzles solved: current/required»', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'intermediate',
      nextLevel: 'advanced',
      unlocked: false,
      blockers: [{ kind: 'puzzles_solved', current: 420, required: 500 }],
    });
    renderWithProviders(<LevelGateBanner from="intermediate" />);
    await waitFor(() =>
      expect(
        screen.getByTestId('level-gate-blocker-puzzles_solved'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('level-gate-blocker-puzzles_solved'),
    ).toHaveTextContent('Puzzles solved: 420/500');
  });

  it('intermediate → advanced: все четыре blocker вместе (граница 1699)', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'intermediate',
      nextLevel: 'advanced',
      unlocked: false,
      blockers: [
        { kind: 'course_not_completed', lessonsRemaining: 4 },
        { kind: 'puzzle_rating', current: 1699, required: 1700 },
        { kind: 'rapid_rating', current: 1399, required: 1400 },
        { kind: 'puzzles_solved', current: 499, required: 500 },
      ],
    });
    renderWithProviders(<LevelGateBanner from="intermediate" />);
    await waitFor(() =>
      expect(screen.getByTestId('level-gate')).toHaveAttribute(
        'data-state',
        'locked',
      ),
    );
    expect(
      screen.getByTestId('level-gate-blocker-course_not_completed'),
    ).toHaveTextContent('Lessons remaining: 4');
    expect(
      screen.getByTestId('level-gate-blocker-puzzle_rating'),
    ).toHaveTextContent('Puzzle rating: 1699/1700');
    expect(
      screen.getByTestId('level-gate-blocker-rapid_rating'),
    ).toHaveTextContent('Rapid rating: 1399/1400');
    expect(
      screen.getByTestId('level-gate-blocker-puzzles_solved'),
    ).toHaveTextContent('Puzzles solved: 499/500');
  });

  it('граница 1700 → blockers пусто, unlocked=true', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'intermediate',
      nextLevel: 'advanced',
      unlocked: true,
      blockers: [],
    });
    renderWithProviders(<LevelGateBanner from="intermediate" />);
    await waitFor(() =>
      expect(screen.getByTestId('level-gate')).toHaveAttribute(
        'data-state',
        'unlocked',
      ),
    );
  });

  it('передаёт `from` в lessonsApi.getLevelGate', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'intermediate',
      nextLevel: 'advanced',
      unlocked: true,
      blockers: [],
    });
    renderWithProviders(<LevelGateBanner from="intermediate" />);
    await waitFor(() =>
      expect(mockLessonsApi.getLevelGate).toHaveBeenCalledWith('intermediate'),
    );
  });

  it('без `from` — дёргает API без аргументов (совместимо со старым поведением)', async () => {
    mockLessonsApi.getLevelGate.mockResolvedValueOnce({
      currentLevel: 'beginner',
      nextLevel: 'intermediate',
      unlocked: true,
      blockers: [],
    });
    renderWithProviders(<LevelGateBanner />);
    await waitFor(() =>
      expect(mockLessonsApi.getLevelGate).toHaveBeenCalledWith(undefined),
    );
  });
});
