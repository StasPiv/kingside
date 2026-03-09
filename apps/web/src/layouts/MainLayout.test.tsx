import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen } from '../test/test-utils';
import { MainLayout } from './MainLayout';

const mockUseAuth = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

/**
 * KS-329: Убрано дублирование ссылки на Leaderboard из header
 *
 * Ссылка на /puzzle-rush/leaderboard удалена из навигации,
 * оставлена только внутри PuzzleRushPage.
 */
describe('KS-329: навигация Puzzle Rush', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'TestUser', ratingBlitz: 1500 },
      loading: false,
      logout: vi.fn(),
    });
  });

  it('навигация НЕ содержит ссылку на /puzzle-rush/leaderboard', () => {
    renderWithProviders(<MainLayout />, { route: '/lobby' });

    const link = screen.queryByText('Leaderboard');
    expect(link).not.toBeInTheDocument();
  });

  it('навигация содержит ссылку на /puzzle-rush', () => {
    renderWithProviders(<MainLayout />, { route: '/lobby' });

    const link = screen.getByText('Puzzle Rush');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/puzzle-rush');
  });
});
