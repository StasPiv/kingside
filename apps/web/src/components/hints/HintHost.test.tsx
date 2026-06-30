// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
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
    anchor: 'game-end-analysis-button',
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
          {ui}
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
    // KS-4720: стрелка к anchor.
    const arrow = screen.getByTestId('hint-popover-arrow');
    expect(arrow).toBeInTheDocument();
    expect(arrow.getAttribute('data-placement')).toBeTruthy();

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

  it('KS-4821: popover с непустым ctaLabel рендерит кнопку под текстом', async () => {
    setupAnchor('game-end-analysis-button');
    wrap(<HintHost />, makeUser());

    await act(async () => {
      fireWs(
        'hint:show',
        makePayload({
          ctaLabel: 'Open analysis',
          ctaHref: '/game/abc/review',
        }),
      );
    });

    const cta = screen.getByTestId('hint-popover-cta');
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveTextContent('Open analysis');
    expect(screen.getByTestId('hint-popover-close')).toBeInTheDocument();
  });

  it('KS-4821: подсказка без ctaLabel — CTA-кнопка не рендерится (текст + крестик)', async () => {
    setupAnchor('game-end-analysis-button');
    wrap(<HintHost />, makeUser());

    await act(async () => {
      fireWs(
        'hint:show',
        makePayload({ ctaLabel: null, ctaHref: null }),
      );
    });

    expect(screen.queryByTestId('hint-popover-cta')).not.toBeInTheDocument();
    expect(screen.getByTestId('hint-popover-close')).toBeInTheDocument();
  });

  it('KS-4821: клик по CTA с внутренним ctaHref → SPA navigate, POST acted, popover закрывается', async () => {
    // Внутренние URL (`/game/...`, `/analysis/...`) идут через React Router
    // `navigate(href)`, не через `window.location.assign` — без перезагрузки,
    // WS-сессия сохраняется.
    setupAnchor('game-end-analysis-button');
    let pathSeen = '/';
    function PathProbe() {
      const { pathname } = require('react-router-dom').useLocation() as {
        pathname: string;
      };
      pathSeen = pathname;
      return <div data-testid="probe" data-path={pathname} />;
    }
    wrap(
      <>
        <HintHost />
        <PathProbe />
      </>,
      makeUser(),
      ['/play'],
    );

    await act(async () => {
      fireWs(
        'hint:show',
        makePayload({
          ctaLabel: 'Open analysis',
          ctaHref: '/game/abc-game-id/review',
        }),
      );
    });
    expect(screen.getByTestId('hint-popover')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('hint-popover-cta'));
    });

    expect(screen.queryByTestId('hint-popover')).not.toBeInTheDocument();
    await waitFor(() => {
      const acted = vi.mocked(fetch).mock.calls.find(
        ([url]) => typeof url === 'string' && url.endsWith('/acted'),
      );
      expect(acted).toBeDefined();
    });
    expect(pathSeen).toBe('/game/abc-game-id/review');
  });

  it('anchor так и не появился за окно ожидания → POST ignored reason=no_anchor, no-render', async () => {
    // KS-4820: окно ожидания anchor сокращено до 2 с (было 30 с в
    // KS-4790). Если за это время `[data-hint-anchor="…"]` не появился —
    // тихо пропускаем с lifecycle `ignored{no_anchor}`.
    vi.useFakeTimers();
    try {
      wrap(<HintHost />, makeUser());
      await act(async () => {
        fireWs(
          'hint:show',
          makePayload({ anchor: 'home-puzzles-tile' }),
        );
      });

      // Сразу после hint:show ignored ещё НЕ отправлен.
      const earlyIgnored = vi.mocked(fetch).mock.calls.find(
        ([url]) => typeof url === 'string' && url.endsWith('/ignored'),
      );
      expect(earlyIgnored).toBeUndefined();

      // Прокрутили окно ожидания (2 секунды + запас).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      const ignored = vi.mocked(fetch).mock.calls.find(
        ([url]) => typeof url === 'string' && url.endsWith('/ignored'),
      );
      expect(ignored).toBeDefined();
      const body = JSON.parse((ignored?.[1] as RequestInit).body as string);
      expect(body).toEqual({ reason: 'no_anchor' });
      expect(screen.queryByTestId('hint-popover')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('anchor появляется уже после hint:show → popover рендерится, POST shown', async () => {
    // KS-4790: правило `bridge-promo-after-3-wasm` триггерится на
    // ws_connected, но `[data-hint-anchor="analysis-bridge-promo"]`
    // рендерится только когда `activeSource === 'wasm'` — после действий
    // пользователя. HintHost должен дождаться появления якоря через
    // MutationObserver и показать popover.
    wrap(<HintHost />, makeUser());
    await act(async () => {
      fireWs(
        'hint:show',
        makePayload({ anchor: 'analysis-bridge-promo' }),
      );
    });

    // Сразу popover'а нет: якоря в DOM ещё нет.
    expect(screen.queryByTestId('hint-popover')).not.toBeInTheDocument();

    // Якорь появляется позже (имитация условного рендера блока).
    await act(async () => {
      setupAnchor('analysis-bridge-promo');
    });

    await waitFor(() =>
      expect(screen.getByTestId('hint-popover')).toBeInTheDocument(),
    );
    await waitFor(() => {
      const shown = vi.mocked(fetch).mock.calls.find(
        ([url]) => typeof url === 'string' && url.endsWith('/shown'),
      );
      expect(shown).toBeDefined();
    });
    // ignored по no_anchor не отправлен.
    const ignored = vi.mocked(fetch).mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/ignored'),
    );
    expect(ignored).toBeUndefined();
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

  it('SPA navigation на quiet-page при активном hint → POST ignored{quiet_page} + popover исчезает', async () => {
    // KS-4813 / ADR-153 §2.4. Сценарий: hint показан на /play, пользователь
    // переходит на /live/round1 — popover должен сразу исчезнуть с
    // lifecycle ignored{quiet_page}, не дожидаясь 30-секундного
    // MutationObserver-fallback'а KS-4790.
    setupAnchor('game-end-analysis-button');
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
    expect(screen.getByTestId('hint-popover')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('nav-trigger'));
    });

    expect(screen.queryByTestId('hint-popover')).not.toBeInTheDocument();
    await waitFor(() => {
      const ignored = vi.mocked(fetch).mock.calls.find(
        ([url], i) => {
          // Берём именно ignored с reason=quiet_page (могут быть и другие
          // ignored из других сценариев — фильтруем по body).
          if (typeof url !== 'string' || !url.endsWith('/ignored')) return false;
          const body = JSON.parse(
            (vi.mocked(fetch).mock.calls[i][1] as RequestInit).body as string,
          );
          return body?.reason === 'quiet_page';
        },
      );
      expect(ignored).toBeDefined();
    });
  });

  it('hint:show приходит когда уже на quiet-page → ignored{quiet_page} немедленно, popover не рендерится', async () => {
    // KS-4813. Edge: user уже на /admin к моменту прихода hint'а
    // (например, через WS replay после reconnect). useEffect срабатывает
    // на смене hint (depsы [pathname, hint, token]) — отбрасываем сразу.
    setupAnchor('admin-some-anchor');
    wrap(<HintHost />, makeUser(), ['/admin/hints']);

    await act(async () => {
      fireWs('hint:show', makePayload({ anchor: 'admin-some-anchor' }));
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
    expect(screen.queryByTestId('hint-popover')).not.toBeInTheDocument();
  });

  it('SPA navigation на нормальную страницу не отменяет hint', async () => {
    // KS-4813. Регрессия: переход на /lessons (не quiet) — popover
    // продолжает жить, ignored{quiet_page} не шлётся.
    setupAnchor('game-end-analysis-button');
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
    expect(screen.getByTestId('hint-popover')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('nav-trigger'));
    });

    expect(screen.getByTestId('hint-popover')).toBeInTheDocument();
    const quietIgnored = vi.mocked(fetch).mock.calls.find(([url], i) => {
      if (typeof url !== 'string' || !url.endsWith('/ignored')) return false;
      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[i][1] as RequestInit).body as string,
      );
      return body?.reason === 'quiet_page';
    });
    expect(quietIgnored).toBeUndefined();
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
