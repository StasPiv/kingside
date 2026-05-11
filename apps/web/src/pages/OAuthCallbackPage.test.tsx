/**
 * KS-2785 (v2): тесты `<OAuthCallbackPage>`.
 *
 * Покрытие:
 *  1. loginWithTokens вызывается один раз с tokens из URL.
 *  2. window.history.replaceState чистит query (F5-защита).
 *  3. tokens в localStorage до завершения mount (useLayoutEffect).
 *  4. UsernameSetupModal получает accessToken из state после очистки query.
 *  5. beforeunload listener вешается при mount (опт-аут bfcache).
 *  6. Без токенов в URL → navigate(/login).
 *  7. error в URL → navigate(/login), loginWithTokens не вызывается.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../test/test-utils';

const navigateMock = vi.fn();
const searchParamsState: { search: string } = { search: '' };
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useSearchParams: () => [
      new URLSearchParams(searchParamsState.search),
      vi.fn(),
    ],
  };
});

const authState: {
  user: { id: string; username: string } | null;
  loading: boolean;
  loginWithTokens: ReturnType<typeof vi.fn>;
  refreshUser: ReturnType<typeof vi.fn>;
} = {
  user: null,
  loading: false,
  loginWithTokens: vi.fn(),
  refreshUser: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../components/UsernameSetupModal', () => ({
  UsernameSetupModal: ({
    accessToken,
  }: {
    accessToken?: string;
  }) => (
    <div
      data-testid="username-setup-modal"
      data-access-token={accessToken ?? ''}
    />
  ),
}));

import { OAuthCallbackPage } from './OAuthCallbackPage';

beforeEach(() => {
  navigateMock.mockReset();
  authState.user = null;
  authState.loading = false;
  authState.loginWithTokens = vi.fn();
  authState.refreshUser = vi.fn().mockResolvedValue(undefined);
  localStorage.clear();
  try {
    window.history.replaceState({}, '', '/oauth/callback');
  } catch {
    /* ignore */
  }
});

describe('<OAuthCallbackPage> KS-2785 v2', () => {
  it('при mount вызывает loginWithTokens один раз с токенами из URL', async () => {
    searchParamsState.search =
      'accessToken=AT123&refreshToken=RT456';
    renderWithProviders(<OAuthCallbackPage />);
    await waitFor(() => {
      expect(authState.loginWithTokens).toHaveBeenCalledTimes(1);
    });
    expect(authState.loginWithTokens).toHaveBeenCalledWith('AT123', 'RT456');
  });

  it('history.replaceState очищает query (защита от F5)', async () => {
    searchParamsState.search =
      'accessToken=AT123&refreshToken=RT456';
    const spy = vi.spyOn(window.history, 'replaceState');
    renderWithProviders(<OAuthCallbackPage />);
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    const calledUrl = spy.mock.calls.find((c) =>
      typeof c[2] === 'string' && (c[2] as string).startsWith('/oauth/callback'),
    )?.[2] as string | undefined;
    expect(calledUrl).toBeDefined();
    expect(calledUrl ?? '').not.toContain('accessToken');
    expect(calledUrl ?? '').not.toContain('refreshToken');
    spy.mockRestore();
  });

  it('токены попадают в localStorage до завершения mount', async () => {
    searchParamsState.search =
      'accessToken=AT_PRE&refreshToken=RT_PRE';
    renderWithProviders(<OAuthCallbackPage />);
    expect(localStorage.getItem('token')).toBe('AT_PRE');
    expect(localStorage.getItem('refreshToken')).toBe('RT_PRE');
  });

  it('UsernameSetupModal получает accessToken из state', async () => {
    searchParamsState.search =
      'accessToken=AT_SETUP&refreshToken=RT_SETUP&requiresUsernameSetup=true';
    renderWithProviders(<OAuthCallbackPage />);
    const modal = await waitFor(() =>
      screen.getByTestId('username-setup-modal'),
    );
    expect(modal.getAttribute('data-access-token')).toBe('AT_SETUP');
  });

  it('beforeunload listener регистрируется при mount (опт-аут bfcache)', async () => {
    searchParamsState.search =
      'accessToken=AT123&refreshToken=RT456';
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderWithProviders(<OAuthCallbackPage />);
    expect(
      addSpy.mock.calls.find((c) => c[0] === 'beforeunload'),
    ).toBeDefined();
    unmount();
    expect(
      removeSpy.mock.calls.find((c) => c[0] === 'beforeunload'),
    ).toBeDefined();
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('без токенов → navigate(/login)', async () => {
    searchParamsState.search = '';
    renderWithProviders(<OAuthCallbackPage />);
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    expect(navigateMock.mock.calls[0][0]).toBe('/login');
  });

  it('с error → navigate(/login), без loginWithTokens', async () => {
    searchParamsState.search = 'error=access_denied';
    renderWithProviders(<OAuthCallbackPage />);
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    expect(authState.loginWithTokens).not.toHaveBeenCalled();
  });
});

void fireEvent;
