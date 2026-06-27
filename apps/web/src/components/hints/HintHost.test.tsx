// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n/index';
import { AuthContext } from '../../context/AuthContext';
import type { User, HintShowPayload } from '@kingside/shared';

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

const API_BASE = 'http://localhost:3001';

function makeUser(): User {
  return {
    id: 'u1',
    username: 'alice',
    email: 'a@a.test',
    ratingBullet: 1500,
    ratingBlitz: 1500,
    ratingRapid: 1500,
    ratingClassical: 1500,
    createdAt: '2026-01-01T00:00:00.000Z',
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
    anchor: 'game-end-analysis-button',
    placement: 'bottom',
    ttlSec: 0,
    ...overrides,
  };
}

function wrap(ui: ReactNode, user: User | null = null) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/']}>
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
          {ui}
        </AuthContext.Provider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

function setupAnchor(anchor: string) {
  const el = document.createElement('button');
  el.setAttribute('data-hint-anchor', anchor);
  el.textContent = 'anchor';
  document.body.appendChild(el);
  return el;
}

describe('HintHost (KS-4703)', () => {
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
    document.querySelectorAll('[data-hint-anchor]').forEach((n) => n.remove());
    listeners.clear();
    vi.restoreAllMocks();
  });

  it('user + WS hint:show → popover, POST shown', async () => {
    setupAnchor('game-end-analysis-button');
    wrap(<HintHost />, makeUser());

    await act(async () => {
      fireWs('hint:show', makePayload());
    });

    expect(screen.getByTestId('hint-popover')).toBeInTheDocument();
    expect(screen.getByText('Analyse this game')).toBeInTheDocument();

    await waitFor(() => {
      const shown = vi.mocked(fetch).mock.calls.find(
        ([url]) => typeof url === 'string' && url.endsWith('/shown'),
      );
      expect(shown).toBeDefined();
    });
  });

  it('click close → POST dismissed + поповер исчезает', async () => {
    setupAnchor('game-end-analysis-button');
    wrap(<HintHost />, makeUser());

    await act(async () => {
      fireWs('hint:show', makePayload());
    });
    expect(screen.getByTestId('hint-popover')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('hint-popover-close'));
    });

    expect(screen.queryByTestId('hint-popover')).not.toBeInTheDocument();
    const dismissed = vi.mocked(fetch).mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/dismissed'),
    );
    expect(dismissed).toBeDefined();
    expect(
      JSON.parse((dismissed?.[1] as RequestInit).body as string),
    ).toEqual({ reason: 'close_button' });
  });

  it('CTA click → POST acted + dispatch CustomEvent при ctaEvent', async () => {
    setupAnchor('board-settings-icon');
    wrap(<HintHost />, makeUser());

    const onEvent = vi.fn();
    window.addEventListener('kingside:hint-cta', onEvent);

    await act(async () => {
      fireWs(
        'hint:show',
        makePayload({
          anchor: 'board-settings-icon',
          ctaHref: null,
          ctaEvent: 'open_board_settings',
        }),
      );
    });
    expect(screen.getByTestId('hint-popover')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('hint-popover-cta'));
    });

    const acted = vi.mocked(fetch).mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/acted'),
    );
    expect(acted).toBeDefined();
    expect(onEvent).toHaveBeenCalled();
    window.removeEventListener('kingside:hint-cta', onEvent);
  });

  it('anchor не найден → POST ignored reason=no_anchor, no-render', async () => {
    wrap(<HintHost />, makeUser());
    await act(async () => {
      fireWs(
        'hint:show',
        makePayload({ anchor: 'home-puzzles-tile' }),
      );
    });

    await waitFor(() => {
      const ignored = vi.mocked(fetch).mock.calls.find(
        ([url]) => typeof url === 'string' && url.endsWith('/ignored'),
      );
      expect(ignored).toBeDefined();
      const body = JSON.parse((ignored?.[1] as RequestInit).body as string);
      expect(body).toEqual({ reason: 'no_anchor' });
    });
    expect(screen.queryByTestId('hint-popover')).not.toBeInTheDocument();
  });

  it('ttl истёк → POST ignored reason=ttl_expired', async () => {
    vi.useFakeTimers();
    try {
      setupAnchor('game-end-analysis-button');
      wrap(<HintHost />, makeUser());

      await act(async () => {
        fireWs('hint:show', makePayload({ ttlSec: 5 }));
      });
      // Дать микротаскам отработать (useEffect ставит таймер).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('hint-popover')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(screen.queryByTestId('hint-popover')).not.toBeInTheDocument();
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

  it('guest без consent — pull не идёт', async () => {
    setupAnchor('landing-signup-button');
    wrap(<HintHost />, null);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const pendingCall = vi.mocked(fetch).mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/hints/pending'),
    );
    expect(pendingCall).toBeUndefined();
  });

  it('guest с consent — pull стартует и применяет первый payload', async () => {
    document.cookie = 'analytics_consent=1; path=/';
    setupAnchor('landing-signup-button');
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/hints/pending')) {
        return new Response(
          JSON.stringify([
            makePayload({
              hintId: '22222222-2222-2222-2222-222222222222',
              anchor: 'landing-signup-button',
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
      expect(screen.getByTestId('hint-popover')).toBeInTheDocument(),
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

  it('переход guest→user — pending перестаёт зваться, WS работает', async () => {
    document.cookie = 'analytics_consent=1; path=/';
    setupAnchor('landing-signup-button');
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
            <HintHost />
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
            <HintHost />
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
      fireWs(
        'hint:show',
        makePayload({ anchor: 'landing-signup-button' }),
      );
    });
    expect(screen.getByTestId('hint-popover')).toBeInTheDocument();
  });
});

// Удалим неиспользованный API_BASE (только URL endpoint'ов проверяем через .endsWith).
void API_BASE;
