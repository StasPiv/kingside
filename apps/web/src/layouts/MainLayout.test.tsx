import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen } from '../test/test-utils';
import { MainLayout } from './MainLayout';

const mockUseAuth = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

/**
 * KS-263: Реверификация фиксов Puzzle Rush
 *
 * KS-252: Навигационная ссылка на /puzzle-rush/leaderboard
 * KS-253: Ссылка Rush Leaderboard в навигации
 */
describe('KS-252/253: навигация Puzzle Rush Leaderboard', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'TestUser', ratingBlitz: 1500 },
      loading: false,
      logout: vi.fn(),
    });
  });

  it('навигация содержит ссылку на /puzzle-rush/leaderboard', () => {
    renderWithProviders(<MainLayout />, { route: '/lobby' });

    const link = screen.getByText('Leaderboard');
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/puzzle-rush/leaderboard');
  });

  it('навигация содержит ссылку на /puzzle-rush', () => {
    renderWithProviders(<MainLayout />, { route: '/lobby' });

    const link = screen.getByText('Puzzle Rush');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/puzzle-rush');
  });
});
