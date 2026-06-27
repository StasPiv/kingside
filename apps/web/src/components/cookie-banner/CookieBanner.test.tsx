// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n/index';
import { AuthContext } from '../../context/AuthContext';
import { CookieBanner } from './CookieBanner';
import type { User } from '@kingside/shared';
import type { UserWithConsent } from './consentTypes';

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

function wrap(
  ui: ReactNode,
  ctx: { user: UserWithConsent | null; refresh?: () => Promise<void> },
) {
  const refresh = ctx.refresh ?? (async () => undefined);
  return render(
    <I18nextProvider i18n={i18n}>
      <AuthContext.Provider
        value={{
          user: ctx.user as User | null,
          token: ctx.user ? 'jwt-test' : null,
          loading: false,
          login: async () => undefined,
          register: async () => undefined,
          loginWithTokens: () => undefined,
          logout: () => undefined,
          refreshUser: refresh,
        }}
      >
        {ui}
      </AuthContext.Provider>
    </I18nextProvider>,
  );
}

describe('CookieBanner (KS-4698)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = 'analytics_consent=; Max-Age=0; path=/';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('гость без сохранённого выбора видит accept/decline', () => {
    wrap(<CookieBanner />, { user: null });
    expect(screen.getByTestId('cookie-banner')).toBeInTheDocument();
    expect(screen.getByTestId('cookie-banner-guest-accept')).toBeInTheDocument();
    expect(screen.getByTestId('cookie-banner-guest-decline')).toBeInTheDocument();
    expect(screen.getByTestId('cookie-banner-guest-delete')).toBeInTheDocument();
  });

  it('гость с cookie analytics_consent=1 — баннер скрыт', () => {
    document.cookie = 'analytics_consent=1; path=/';
    wrap(<CookieBanner />, { user: null });
    expect(screen.queryByTestId('cookie-banner')).not.toBeInTheDocument();
  });

  it('гость нажимает «Не сейчас» — баннер скрывается на 30 дней', async () => {
    wrap(<CookieBanner />, { user: null });
    fireEvent.click(screen.getByTestId('cookie-banner-guest-dismiss'));
    await waitFor(() =>
      expect(screen.queryByTestId('cookie-banner')).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem('cookieBanner.guestDismissedAt')).toBeTruthy();
  });

  it('гость accept → POST /guest/consent {analytics:true}', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ analytics: true, guestIssued: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    wrap(<CookieBanner />, { user: null });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cookie-banner-guest-accept'));
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${API_BASE}/guest/consent`);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).credentials).toBe('include');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      analytics: true,
    });
  });

  it('гость decline → POST /guest/consent {analytics:false} + dismissed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ analytics: false, guestIssued: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    wrap(<CookieBanner />, { user: null });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cookie-banner-guest-decline'));
    });
    expect(localStorage.getItem('cookieBanner.guestDismissedAt')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByTestId('cookie-banner')).not.toBeInTheDocument(),
    );
  });

  it('гость delete: confirm → DELETE /guest/analytics-data, баннер скрыт', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ eventsDeleted: 5, aggKeysDeleted: 1 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    wrap(<CookieBanner />, { user: null });
    fireEvent.click(screen.getByTestId('cookie-banner-guest-delete'));
    expect(
      screen.getByTestId('cookie-banner-guest-delete-confirm'),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('cookie-banner-guest-delete-yes'));
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${API_BASE}/guest/analytics-data`);
    expect((init as RequestInit).method).toBe('DELETE');
    await waitFor(() =>
      expect(screen.queryByTestId('cookie-banner')).not.toBeInTheDocument(),
    );
  });

  it('гость delete: cancel — DELETE не вызывается', () => {
    wrap(<CookieBanner />, { user: null });
    fireEvent.click(screen.getByTestId('cookie-banner-guest-delete'));
    fireEvent.click(screen.getByTestId('cookie-banner-guest-delete-no'));
    expect(
      screen.queryByTestId('cookie-banner-guest-delete-confirm'),
    ).not.toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('гость POST ошибка — показывается error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('boom', { status: 500 }));
    wrap(<CookieBanner />, { user: null });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cookie-banner-guest-accept'));
    });
    expect(screen.getByTestId('cookie-banner-error')).toBeInTheDocument();
  });

  it('user без consent видит чекбокс accept/decline', () => {
    wrap(<CookieBanner />, { user: makeUser({ analyticsConsent: null }) });
    expect(screen.getByTestId('cookie-banner-accept')).toBeInTheDocument();
    expect(screen.getByTestId('cookie-banner-decline')).toBeInTheDocument();
  });

  it('user с consent=true — баннер скрыт', () => {
    wrap(<CookieBanner />, { user: makeUser({ analyticsConsent: true }) });
    expect(screen.queryByTestId('cookie-banner')).not.toBeInTheDocument();
  });

  it('user с consent=false — баннер скрыт', () => {
    wrap(<CookieBanner />, { user: makeUser({ analyticsConsent: false }) });
    expect(screen.queryByTestId('cookie-banner')).not.toBeInTheDocument();
  });

  it('user click accept → PATCH /me/consent {analytics:true}', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ analytics: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const refresh = vi.fn(async () => undefined);
    wrap(<CookieBanner />, {
      user: makeUser({ analyticsConsent: null }),
      refresh,
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('cookie-banner-accept'));
    });

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(`${API_BASE}/me/consent`);
    expect((call[1] as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      analytics: true,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('user click decline → PATCH /me/consent {analytics:false}', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ analytics: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const refresh = vi.fn(async () => undefined);
    wrap(<CookieBanner />, {
      user: makeUser({ analyticsConsent: null }),
      refresh,
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('cookie-banner-decline'));
    });

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ analytics: false });
    expect(refresh).toHaveBeenCalled();
  });

  it('ошибка PATCH показывает текст ошибки', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    );
    wrap(<CookieBanner />, {
      user: makeUser({ analyticsConsent: null }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cookie-banner-accept'));
    });
    expect(screen.getByTestId('cookie-banner-error')).toBeInTheDocument();
  });
});
