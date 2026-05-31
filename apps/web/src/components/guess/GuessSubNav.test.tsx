import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { GuessSubNav } from './GuessSubNav';

/**
 * KS-3510 (ADR-093 §F-guess). GuessSubNav: 3 вкладки для auth,
 * только Training для гостя; aria-current на активной.
 */

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

describe('<GuessSubNav> KS-3510', () => {
  it('auth: рендерит 3 вкладки', () => {
    renderWithProviders(<GuessSubNav />, { route: '/guess' });
    expect(screen.getByTestId('guess-subnav')).toBeInTheDocument();
    expect(screen.getByTestId('guess-subnav-training')).toBeInTheDocument();
    expect(screen.getByTestId('guess-subnav-progress')).toBeInTheDocument();
    expect(screen.getByTestId('guess-subnav-history')).toBeInTheDocument();
    // Training active по pathname.
    expect(
      screen.getByTestId('guess-subnav-training').getAttribute('aria-current'),
    ).toBe('page');
  });

  it('гость: видит только Training', () => {
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
    renderWithProviders(<GuessSubNav />, { route: '/guess' });
    expect(screen.getByTestId('guess-subnav-training')).toBeInTheDocument();
    expect(screen.queryByTestId('guess-subnav-progress')).toBeNull();
    expect(screen.queryByTestId('guess-subnav-history')).toBeNull();
  });

  it('/guess/stats: Progress active', () => {
    renderWithProviders(<GuessSubNav />, { route: '/guess/stats' });
    expect(
      screen.getByTestId('guess-subnav-progress').getAttribute('aria-current'),
    ).toBe('page');
  });
});
