// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../i18n/index';
import { AuthContext } from '../../../context/AuthContext';
import { PrivacyTab } from './PrivacyTab';
import type { User } from '@kingside/shared';
import type { UserWithConsent } from '../../../components/cookie-banner/consentTypes';

const API_BASE = 'http://localhost:3001';

function makeUser(extra: Partial<UserWithConsent> = {}): UserWithConsent {
  return {
    id: 'u1',
    username: 'alice',
    email: 'alice@example.test',
    ratingBullet: 1500,
    ratingBlitz: 1500,
    ratingRapid: 1500,
    ratingClassical: 1500,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function wrap(user: UserWithConsent | null, refresh = vi.fn(async () => undefined)) {
  return render(
    <I18nextProvider i18n={i18n}>
      <AuthContext.Provider
        value={{
          user: user as User | null,
          token: user ? 'jwt-test' : null,
          loading: false,
          login: async () => undefined,
          register: async () => undefined,
          loginWithTokens: () => undefined,
          logout: () => undefined,
          refreshUser: refresh,
        }}
      >
        <PrivacyTab />
      </AuthContext.Provider>
    </I18nextProvider>,
  );
}

describe('PrivacyTab (KS-4698)', () => {
  beforeEach(() => {
    // happy-dom не имеет URL.createObjectURL/click-handling, эмулируем.
    if (typeof URL.createObjectURL !== 'function') {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: () => 'blob:mock',
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: () => undefined,
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('гость — заглушка с приглашением войти', () => {
    wrap(null);
    expect(screen.getByTestId('settings-privacy-tab')).toBeInTheDocument();
    expect(
      screen.queryByTestId('settings-privacy-consent-toggle'),
    ).not.toBeInTheDocument();
  });

  it('user видит чекбокс согласия', () => {
    wrap(makeUser({ analyticsConsent: false }));
    const toggle = screen.getByTestId(
      'settings-privacy-consent-toggle',
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it('clicking checkbox triggers PATCH /me/consent', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ analytics: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const refresh = vi.fn(async () => undefined);
    wrap(makeUser({ analyticsConsent: false }), refresh);

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-privacy-consent-toggle'));
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${API_BASE}/me/consent`);
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      analytics: true,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('кнопка экспорта вызывает GET /me/analytics-export с Authorization', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"events":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    wrap(makeUser({ analyticsConsent: true }));

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-privacy-export-button'));
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${API_BASE}/me/analytics-export`);
    expect((init as RequestInit).method).toBe('GET');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer jwt-test');
  });

  it('403 на экспорте → показывает rate-limited сообщение', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 403 }));
    wrap(makeUser({ analyticsConsent: true }));

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-privacy-export-button'));
    });

    expect(
      screen.getByTestId('settings-privacy-export-ratelimited'),
    ).toBeInTheDocument();
  });

  it('кнопка delete → confirm → подтверждение → DELETE /me/analytics-data', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ eventsDeleted: 42, aggKeysDeleted: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    wrap(makeUser({ analyticsConsent: true }));

    fireEvent.click(screen.getByTestId('settings-privacy-delete-button'));
    expect(
      screen.getByTestId('settings-privacy-delete-confirm'),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-privacy-delete-confirm-yes'));
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${API_BASE}/me/analytics-data`);
    expect((init as RequestInit).method).toBe('DELETE');

    await waitFor(() =>
      expect(screen.getByTestId('settings-privacy-delete-done')).toBeInTheDocument(),
    );
  });

  it('confirm cancel — DELETE не вызывается', () => {
    wrap(makeUser({ analyticsConsent: true }));
    fireEvent.click(screen.getByTestId('settings-privacy-delete-button'));
    fireEvent.click(screen.getByTestId('settings-privacy-delete-confirm-no'));
    expect(
      screen.queryByTestId('settings-privacy-delete-confirm'),
    ).not.toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
