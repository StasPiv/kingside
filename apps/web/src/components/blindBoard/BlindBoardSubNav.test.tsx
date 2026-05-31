import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { BlindBoardSubNav } from './BlindBoardSubNav';

const { mockUseAuth } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(() => ({
    user: { id: 'u1', username: 't' },
    token: 'jwt',
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    loginWithTokens: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  })),
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe('<BlindBoardSubNav> KS-3511', () => {
  it('auth: 3 вкладки + Training active на /blind-board', () => {
    renderWithProviders(<BlindBoardSubNav />, { route: '/blind-board' });
    expect(screen.getByTestId('blind-board-subnav')).toBeInTheDocument();
    expect(
      screen.getByTestId('blind-board-subnav-training'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('blind-board-subnav-progress'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('blind-board-subnav-history'),
    ).toBeInTheDocument();
    expect(
      screen
        .getByTestId('blind-board-subnav-training')
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('гость: только Training', () => {
    mockUseAuth.mockReturnValueOnce({
      user: null,
      token: null,
      loading: false,
      login: vi.fn(),
      register: vi.fn(),
      loginWithTokens: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    } as ReturnType<typeof mockUseAuth>);
    renderWithProviders(<BlindBoardSubNav />, { route: '/blind-board' });
    expect(
      screen.getByTestId('blind-board-subnav-training'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('blind-board-subnav-progress')).toBeNull();
    expect(screen.queryByTestId('blind-board-subnav-history')).toBeNull();
  });

  it('/blind-board/stats: Progress active', () => {
    renderWithProviders(<BlindBoardSubNav />, {
      route: '/blind-board/stats',
    });
    expect(
      screen
        .getByTestId('blind-board-subnav-progress')
        .getAttribute('aria-current'),
    ).toBe('page');
  });
});
