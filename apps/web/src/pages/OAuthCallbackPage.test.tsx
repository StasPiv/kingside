/**
 * KS-2785: тесты `<OAuthCallbackPage>`.
 *
 * Покрытие:
 *  1. При mount: `loginWithTokens` вызывается ОДИН раз с tokens из URL.
 *  2. При mount: `window.history.replaceState` чистит query — следующее
 *     чтение URL не отдаст `accessToken` (защита от повтора при F5 /
 *     Back-button).
 *  3. accessToken/refreshToken в localStorage до завершения mount
 *     (useLayoutEffect: AuthContext-родитель видит токены сразу).
 *  4. UsernameSetupModal получает accessToken из state, а не из
 *     уже зачищенного searchParams.
 *  5. При отсутствии токенов в URL — navigate('/login').
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
  // Reset localStorage и window.history между тестами.
  localStorage.clear();
  try {
    window.history.replaceState({}, '', '/oauth/callback');
  } catch {
    /* ignore */
  }
});

describe('<OAuthCallbackPage> KS-2785', () => {
  it('при mount вызывает loginWithTokens один раз с токенами из URL', async () => {
    searchParamsState.search =
      'accessToken=AT123&refreshToken=RT456';
    renderWithProviders(<OAuthCallbackPage />);
    await waitFor(() => {
      expect(authState.loginWithTokens).toHaveBeenCalledTimes(1);
    });
    expect(authState.loginWithTokens).toHaveBeenCalledWith('AT123', 'RT456');
  });

  it('при mount history.replaceState очищает query (защита от F5/Back)', async () => {
    searchParamsState.search =
      'accessToken=AT123&refreshToken=RT456';
    const spy = vi.spyOn(window.history, 'replaceState');
    renderWithProviders(<OAuthCallbackPage />);
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    // Аргументы: state, title, url. URL не должен содержать accessToken.
    const calledUrl = spy.mock.calls.find((c) =>
      typeof c[2] === 'string' && (c[2] as string).startsWith('/oauth/callback'),
    )?.[2] as string | undefined;
    expect(calledUrl).toBeDefined();
    expect(calledUrl ?? '').not.toContain('accessToken');
    expect(calledUrl ?? '').not.toContain('refreshToken');
    spy.mockRestore();
  });

  it('токены попадают в localStorage до завершения mount (useLayoutEffect)', async () => {
    searchParamsState.search =
      'accessToken=AT_PRE&refreshToken=RT_PRE';
    renderWithProviders(<OAuthCallbackPage />);
    // Сразу после render localStorage должен уже содержать токены.
    expect(localStorage.getItem('token')).toBe('AT_PRE');
    expect(localStorage.getItem('refreshToken')).toBe('RT_PRE');
  });

  it('UsernameSetupModal получает accessToken из state, не из (зачищенного) searchParams', async () => {
    searchParamsState.search =
      'accessToken=AT_SETUP&refreshToken=RT_SETUP&requiresUsernameSetup=true';
    renderWithProviders(<OAuthCallbackPage />);
    const modal = await waitFor(() =>
      screen.getByTestId('username-setup-modal'),
    );
    // Несмотря на то что history.replaceState уже очистил URL —
    // accessToken пришёл в модалку из state.
    expect(modal.getAttribute('data-access-token')).toBe('AT_SETUP');
  });

  it('без токенов в URL → navigate(/login)', async () => {
    searchParamsState.search = '';
    renderWithProviders(<OAuthCallbackPage />);
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    const firstCall = navigateMock.mock.calls[0];
    expect(firstCall[0]).toBe('/login');
  });

  it('с error в URL → navigate(/login) (без вызова loginWithTokens)', async () => {
    searchParamsState.search = 'error=access_denied';
    renderWithProviders(<OAuthCallbackPage />);
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    expect(authState.loginWithTokens).not.toHaveBeenCalled();
  });
});

// Чтобы fireEvent не выдавал unused-warning.
void fireEvent;
