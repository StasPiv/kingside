// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n/index';
import { AuthContext } from '../../context/AuthContext';
import type { User, HintShowPayload } from '@kingside/shared';
import { InfoBar, InfoBarProvider } from '../info-bar/InfoBar';

// Замокаем socket-модуль ДО импорта HintHost. socket.io-client `emit` шлёт
// событие на сервер, не вызывает локальные listeners. Подменяем минимальной
// реализацией с прямой ре-эмиссией для теста. vi.hoisted — чтобы factory
// vi.mock увидела переменные (hoisting обычных const ломается).
const { listeners, fireWs } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const map = new Map<string, Set<Listener>>();
  return {
    listeners: map,
    fireWs(event: string, payload: unknown) {
      const set = map.get(event);
      if (!set) return;
      for (const cb of set) cb(payload);
    },
  };
});

vi.mock('../../socket', () => {
  type Listener = (...args: unknown[]) => void;
  return {
    messagesSocket: {
      auth: undefined,
      connected: true,
      connect: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn((event: string, cb: Listener) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
      }),
      off: vi.fn((event: string, cb?: Listener) => {
        const set = listeners.get(event);
        if (!set) return;
        if (cb) set.delete(cb);
        else set.clear();
      }),
    },
  };
});

import { HintHost } from './HintHost';

function makeUser(): User {
  // KS-4718: isAnalyticsConsentGiven(user) требует analyticsConsent=true
  // — иначе HintHost корректно «выключен» (по ADR-147 §6.2).
  return {
    id: 'u1',
    username: 'alice',
    email: 'a@a.test',
    ratingBullet: 1500,
    ratingBlitz: 1500,
    ratingRapid: 1500,
    ratingClassical: 1500,
    createdAt: '2026-01-01T00:00:00.000Z',
    // analyticsConsent поля нет в shared User — поэтому через cast.
    ...({ analyticsConsent: true } as Record<string, unknown>),
  };
}

function makePayload(overrides: Partial<HintShowPayload> = {}): HintShowPayload {
  return {
    hintId: '11111111-1111-1111-1111-111111111111',
    key: 'analyze-your-game',
    locale: 'en',
    title: 'Analyse this game',
    body: 'Tap Analyse to start.',
    ctaLabel: 'Analyse',
    ctaHref: '/analyse',
    ctaEvent: null,
    // KS-4815: anchor сохранён в payload (для бэк-аналитики), но фронт
    // его не использует — все подсказки рендерятся в общую InfoBar.
    anchor: 'legacy',
    placement: 'bottom',
    ttlSec: 0,
    ...overrides,
  };
}

function wrap(
  ui: ReactNode,
  user: User | null = null,
  initialEntries: string[] = ['/'],
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={initialEntries}>
        <AuthContext.Provider
          value={{
            user,
            token: user ? 'jwt-test' : null,
            loading: false,
            login: async () => undefined,
            register: async () => undefined,
            loginWithTokens: () => undefined,
            logout: () => undefined,
            refreshUser: async () => undefined,
          }}
        >
          <InfoBarProvider>
            <InfoBar />
            {ui}
          </InfoBarProvider>
        </AuthContext.Provider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

// KS-4813. Тестовый компонент-навигатор: позволяет внутри теста
// инициировать SPA-переход через `useNavigate`, чтобы триггерить
// `useEffect` HintHost'а по `useLocation`.
function NavTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="nav-trigger"
      onClick={() => navigate(to)}
    >
      go
    </button>
  );
}

describe('HintHost (KS-4703 / KS-4815)', () => {
  beforeEach(() => {
    document.cookie = 'analytics_consent=; Max-Age=0; path=/';
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 0,
    });
    listeners.clear();
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 204 }));
  });

  afterEach(() => {
    listeners.clear();
    vi.restoreAllMocks();
  });

  it('user + WS hint:show → рендер в InfoBar, POST shown', async () => {
    wrap(<HintHost />, makeUser());

    await act(async () => {
      fireWs('hint:show', makePayload());
    });

    expect(screen.getByTestId('hint-info-bar')).toBeInTheDocument();
    expect(screen.getByText('Analyse this game')).toBeInTheDocument();
    expect(screen.getByText('Tap Analyse to start.')).toBeInTheDocument();
    expect(screen.getByTestId('info-bar-cta')).toHaveTextContent('Analyse');

    await waitFor(() => {
      const shown = vi.mocked(fetch).mock.calls.find(
        ([url]) => typeof url === 'string' && url.endsWith('/shown'),
      );
      expect(shown).toBeDefined();
    });
  });

  it('клик по крестику → POST dismissed + InfoBar исчезает', async () => {
    wrap(<HintHost />, makeUser());

    await act(async () => {
      fireWs('hint:show', makePayload());
    });
    expect(screen.getByTestId('hint-info-bar')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('info-bar-close'));
    });

    expect(screen.queryByTestId('hint-info-bar')).not.toBeInTheDocument();
    const dismissed = vi.mocked(fetch).mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/dismissed'),
    );
    expect(dismissed).toBeDefined();
    expect(
      JSON.parse((dismissed?.[1] as RequestInit).body as string),
    ).toEqual({ reason: 'close_button' });
  });

  it('клик по CTA → POST acted + dispatch CustomEvent при ctaEvent', async () => {
    wrap(<HintHost />, makeUser());

    const onEvent = vi.fn();
    window.addEventListener('kingside:hint-cta', onEvent);

    await act(async () => {
      fireWs(
        'hint:show',
        makePayload({
          ctaHref: null,
          ctaEvent: 'open_board_settings',
        }),
      );
    });
    expect(screen.getByTestId('hint-info-bar')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('info-bar-cta'));
    });

    const acted = vi.mocked(fetch).mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/acted'),
    );
    expect(acted).toBeDefined();
    expect(onEvent).toHaveBeenCalled();
    window.removeEventListener('kingside:hint-cta', onEvent);
  });

  it('ttl истёк → POST ignored reason=ttl_expired', async () => {
    vi.useFakeTimers();
    try {
      wrap(<HintHost />, makeUser());

      await act(async () => {
        fireWs('hint:show', makePayload({ ttlSec: 5 }));
      });
      // Дать микротаскам отработать (useEffect ставит таймер).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('hint-info-bar')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(screen.queryByTestId('hint-info-bar')).not.toBeInTheDocument();
      const ignored = vi.mocked(fetch).mock.calls.find(
        ([url]) => typeof url === 'string' && url.endsWith('/ignored'),
      );
      expect(ignored).toBeDefined();
      expect(
        JSON.parse((ignored?.[1] as RequestInit).body as string),
      ).toEqual({ reason: 'ttl_expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('гость без consent — pull не идёт, InfoBar пуст', async () => {
    wrap(<HintHost />, null);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const pendingCall = vi.mocked(fetch).mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/hints/pending'),
    );
    expect(pendingCall).toBeUndefined();
    expect(screen.queryByTestId('hint-info-bar')).not.toBeInTheDocument();
  });

  it('гость с consent — pull стартует и применяет первый payload в InfoBar', async () => {
    document.cookie = 'analytics_consent=1; path=/';
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/hints/pending')) {
        return new Response(
          JSON.stringify([
            makePayload({
              hintId: '22222222-2222-2222-2222-222222222222',
              ctaHref: '/register',
            }),
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 204 });
    });

    wrap(<HintHost />, null);

    await waitFor(() =>
      expect(screen.getByTestId('hint-info-bar')).toBeInTheDocument(),
    );
    // Лайфсайкл shown отправлен для guest (без Authorization).
    await waitFor(() => {
      const shown = vi.mocked(fetch).mock.calls.find(
        ([url]) =>
          typeof url === 'string' &&
          url.endsWith('/22222222-2222-2222-2222-222222222222/shown'),
      );
      expect(shown).toBeDefined();
      const headers =
        (shown?.[1] as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  it('переход guest→user — pending перестаёт зваться, WS работает, рендер в InfoBar', async () => {
    document.cookie = 'analytics_consent=1; path=/';
    let pendingCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/hints/pending')) {
        pendingCalls++;
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/']}>
          <AuthContext.Provider
            value={{
              user: null,
              token: null,
              loading: false,
              login: async () => undefined,
              register: async () => undefined,
              loginWithTokens: () => undefined,
              logout: () => undefined,
              refreshUser: async () => undefined,
            }}
          >
            <InfoBarProvider>
              <InfoBar />
              <HintHost />
            </InfoBarProvider>
          </AuthContext.Provider>
        </MemoryRouter>
      </I18nextProvider>,
    );

    await waitFor(() => expect(pendingCalls).toBeGreaterThan(0));

    rerender(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/']}>
          <AuthContext.Provider
            value={{
              user: makeUser(),
              token: 'jwt',
              loading: false,
              login: async () => undefined,
              register: async () => undefined,
              loginWithTokens: () => undefined,
              logout: () => undefined,
              refreshUser: async () => undefined,
            }}
          >
            <InfoBarProvider>
              <InfoBar />
              <HintHost />
            </InfoBarProvider>
          </AuthContext.Provider>
        </MemoryRouter>
      </I18nextProvider>,
    );

    await new Promise((r) => setTimeout(r, 50));
    const before = pendingCalls;
    await new Promise((r) => setTimeout(r, 100));
    expect(pendingCalls).toBe(before);

    // WS теперь работает.
    await act(async () => {
      fireWs('hint:show', makePayload());
    });
    expect(screen.getByTestId('hint-info-bar')).toBeInTheDocument();
  });

  it('SPA navigation на quiet-page при активном hint → POST ignored{quiet_page} + InfoBar исчезает', async () => {
    // KS-4813 / ADR-153 §2.4. Сценарий: hint показан на /play, пользователь
    // переходит на /live/round1 — InfoBar должен сразу исчезнуть с
    // lifecycle ignored{quiet_page}.
    wrap(
      <>
        <HintHost />
        <NavTo to="/live/round1" />
      </>,
      makeUser(),
      ['/play'],
    );

    await act(async () => {
      fireWs('hint:show', makePayload());
    });
    expect(screen.getByTestId('hint-info-bar')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('nav-trigger'));
    });

    expect(screen.queryByTestId('hint-info-bar')).not.toBeInTheDocument();
    await waitFor(() => {
      const ignored = vi.mocked(fetch).mock.calls.find(([url], i) => {
        if (typeof url !== 'string' || !url.endsWith('/ignored')) return false;
        const body = JSON.parse(
          (vi.mocked(fetch).mock.calls[i][1] as RequestInit).body as string,
        );
        return body?.reason === 'quiet_page';
      });
      expect(ignored).toBeDefined();
    });
  });

  it('hint:show приходит когда уже на quiet-page → ignored{quiet_page} немедленно, InfoBar не рендерится', async () => {
    wrap(<HintHost />, makeUser(), ['/admin/hints']);

    await act(async () => {
      fireWs('hint:show', makePayload());
    });

    await waitFor(() => {
      const ignored = vi.mocked(fetch).mock.calls.find(([url], i) => {
        if (typeof url !== 'string' || !url.endsWith('/ignored')) return false;
        const body = JSON.parse(
          (vi.mocked(fetch).mock.calls[i][1] as RequestInit).body as string,
        );
        return body?.reason === 'quiet_page';
      });
      expect(ignored).toBeDefined();
    });
    expect(screen.queryByTestId('hint-info-bar')).not.toBeInTheDocument();
  });

  it('SPA navigation на нормальную страницу не отменяет hint', async () => {
    wrap(
      <>
        <HintHost />
        <NavTo to="/lessons" />
      </>,
      makeUser(),
      ['/play'],
    );

    await act(async () => {
      fireWs('hint:show', makePayload());
    });
    expect(screen.getByTestId('hint-info-bar')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('nav-trigger'));
    });

    expect(screen.getByTestId('hint-info-bar')).toBeInTheDocument();
    const quietIgnored = vi.mocked(fetch).mock.calls.find(([url], i) => {
      if (typeof url !== 'string' || !url.endsWith('/ignored')) return false;
      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[i][1] as RequestInit).body as string,
      );
      return body?.reason === 'quiet_page';
    });
    expect(quietIgnored).toBeUndefined();
  });
});
