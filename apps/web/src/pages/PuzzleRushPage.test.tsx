import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen } from '../test/test-utils';
import { PuzzleRushPage } from './PuzzleRushPage';

// Mock dependencies
vi.mock('../api-puzzle', () => ({
  puzzleApi: {
    startRush: vi.fn(),
    solveRush: vi.fn(),
    getRushLeaderboard: vi.fn(),
  },
}));

vi.mock('../hooks/useContainerWidth', () => ({
  useContainerWidth: () => 400,
}));

vi.mock('../hooks/useFastDrag', () => ({
  useFastDrag: vi.fn(),
}));

vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard" />,
}));

const mockUseAuth = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

/**
 * KS-263: Реверификация фиксов Puzzle Rush
 *
 * KS-253: Ссылка .rush-leaderboard-link присутствует на стартовом экране
 */
describe('KS-253: ссылка на лидерборд на стартовом экране', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'Test' },
      loading: false,
    });
  });

  it('ссылка .rush-leaderboard-link присутствует на стартовом экране', () => {
    renderWithProviders(<PuzzleRushPage />, { route: '/puzzle-rush' });

    const link = screen.getByText('Leaderboard');
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/puzzle-rush/leaderboard');
    expect(link).toHaveClass('rush-leaderboard-link');
  });
});
