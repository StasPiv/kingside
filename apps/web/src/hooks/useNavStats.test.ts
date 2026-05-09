import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import React from 'react';

const apiPostMock = vi.fn();
const apiGetMock = vi.fn();
vi.mock('../api', () => ({
  api: {
    post: (path: string, body: unknown) => apiPostMock(path, body),
    get: (path: string) => apiGetMock(path),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}));

const authState: { user: { id: string } | null } = {
  user: { id: 'u1' },
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, loading: false }),
}));

const flagsState = {
  lessonsEnabled: true,
  puzzlesEnabled: true,
  broadcastsEnabled: true,
  tournamentsEnabled: true,
  drillsEnabled: true,
  assistantEnabled: false,
};
vi.mock('../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({
    flags: flagsState,
    loading: false,
    error: null,
    refresh: async () => {},
  }),
  useFeatureFlag: (key: keyof typeof flagsState) => flagsState[key],
}));

import {
  resolveNavRoute,
  useTrackNavStats,
  useTopNavStats,
  NAV_ROUTES,
} from './useNavStats';

beforeEach(() => {
  apiPostMock.mockReset();
  apiGetMock.mockReset();
  apiPostMock.mockResolvedValue(undefined);
  apiGetMock.mockResolvedValue({ items: [] });
  authState.user = { id: 'u1' };
  flagsState.lessonsEnabled = true;
  flagsState.puzzlesEnabled = true;
  flagsState.broadcastsEnabled = true;
  flagsState.tournamentsEnabled = true;
  flagsState.drillsEnabled = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveNavRoute (KS-2373)', () => {
  it('возвращает route для каждого whitelist префикса', () => {
    expect(resolveNavRoute('/play')).toBe('play');
    expect(resolveNavRoute('/play/some')).toBe('play');
    expect(resolveNavRoute('/tournaments/abc')).toBe('tournaments');
    expect(resolveNavRoute('/workshop')).toBe('workshop');
    expect(resolveNavRoute('/analysis/xyz')).toBe('workshop');
    expect(resolveNavRoute('/lessons/capablanca-primer')).toBe('lessons');
    expect(resolveNavRoute('/drills/find-pin')).toBe('drills');
    expect(resolveNavRoute('/broadcasts/123')).toBe('broadcasts');
    expect(resolveNavRoute('/archive/games/abc')).toBe('archive');
    expect(resolveNavRoute('/profile')).toBe('profile');
    expect(resolveNavRoute('/player/tester')).toBe('profile');
    // KS-2613: `/daily` больше не входит в matches (страница удалена,
    // /daily теперь редиректит на /puzzles).
    expect(resolveNavRoute('/daily')).toBeNull();
    expect(resolveNavRoute('/puzzles')).toBe('puzzles');
    expect(resolveNavRoute('/puzzle-rush')).toBe('puzzles');
    expect(resolveNavRoute('/puzzle/abc')).toBe('puzzles');
  });

  it('null для путей вне whitelist', () => {
    expect(resolveNavRoute('/')).toBeNull();
    expect(resolveNavRoute('/settings')).toBeNull();
    expect(resolveNavRoute('/game/abc')).toBeNull();
    expect(resolveNavRoute('/feedback')).toBeNull();
    expect(resolveNavRoute('/login')).toBeNull();
  });

  it('KS-2540: /precision и его подпути → precision', () => {
    expect(resolveNavRoute('/precision')).toBe('precision');
    expect(resolveNavRoute('/precision/abc')).toBe('precision');
  });

  it('KS-2540: /precision не пересекается с другими ключами', () => {
    // Префикс не должен совпасть с /play, /puzzles, /puzzle-rush.
    expect(resolveNavRoute('/precision')).not.toBe('play');
    expect(resolveNavRoute('/precision')).not.toBe('puzzles');
  });

  it('KS-2540: NAV_ROUTES.precision имеет корректный мета', () => {
    expect(NAV_ROUTES.precision.to).toBe('/precision');
    expect(NAV_ROUTES.precision.flag).toBe('puzzlesEnabled');
    expect(NAV_ROUTES.precision.matches).toEqual(['/precision']);
  });
});

function makeWrapper(initialPath: string) {
  return ({ children }: { children: ReactNode }) =>
    React.createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      children,
    );
}

describe('useTrackNavStats (KS-2373)', () => {
  it('после 3.5с pathname → POST increment с маппингом route', async () => {
    vi.useFakeTimers();
    renderHook(() => useTrackNavStats(), { wrapper: makeWrapper('/drills/find-pin') });
    expect(apiPostMock).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(apiPostMock).toHaveBeenCalledWith(
      '/user/nav-stats/increment',
      { route: 'drills' },
    );
  });

  it('pathname вне whitelist → POST не вызывается', () => {
    vi.useFakeTimers();
    renderHook(() => useTrackNavStats(), { wrapper: makeWrapper('/settings') });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('unauth (user=null) → POST не вызывается', () => {
    vi.useFakeTimers();
    authState.user = null;
    renderHook(() => useTrackNavStats(), { wrapper: makeWrapper('/drills') });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('ошибка POST не валит компонент (silent catch)', async () => {
    vi.useFakeTimers();
    apiPostMock.mockRejectedValue(new Error('500'));
    renderHook(() => useTrackNavStats(), { wrapper: makeWrapper('/drills') });
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    // Без unhandledrejection.
    await Promise.resolve();
    expect(apiPostMock).toHaveBeenCalled();
  });
});

describe('useTopNavStats (KS-2373)', () => {
  it('фильтрует non-whitelist routes из ответа', async () => {
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'drills', count: 10 },
        { route: 'unknown-route', count: 9 }, // отбросится
        { route: 'archive', count: 5 },
      ],
    });
    const { result } = renderHook(() => useTopNavStats(3), {
      wrapper: makeWrapper('/'),
    });
    await waitFor(() => expect(result.current.routes.length).toBe(2));
    expect(result.current.routes).toEqual(['drills', 'archive']);
  });

  it('фильтрует по feature-flag (drillsEnabled=false → drills не возвращён)', async () => {
    flagsState.drillsEnabled = false;
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'drills', count: 100 },
        { route: 'play', count: 5 },
        { route: 'workshop', count: 4 },
        { route: 'archive', count: 3 },
      ],
    });
    const { result } = renderHook(() => useTopNavStats(3), {
      wrapper: makeWrapper('/'),
    });
    await waitFor(() => expect(result.current.routes.length).toBe(3));
    expect(result.current.routes).toEqual(['play', 'workshop', 'archive']);
  });

  it('запрашивает limit=limit*3 (запас на feature-flag фильтр)', async () => {
    renderHook(() => useTopNavStats(3), { wrapper: makeWrapper('/') });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(apiGetMock).toHaveBeenCalledWith('/user/nav-stats/top?limit=9');
  });

  it('unauth → пустой массив без запроса', async () => {
    authState.user = null;
    const { result } = renderHook(() => useTopNavStats(3), {
      wrapper: makeWrapper('/'),
    });
    await waitFor(() => expect(result.current.routes).toEqual([]));
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});

describe('NAV_ROUTES (KS-2373) — целостность whitelist', () => {
  it('содержит ровно 10 routes как backend whitelist (KS-2540 +precision)', () => {
    expect(Object.keys(NAV_ROUTES).sort()).toEqual(
      [
        'archive',
        'broadcasts',
        'drills',
        'lessons',
        'play',
        'precision',
        'profile',
        'puzzles',
        'tournaments',
        'workshop',
      ].sort(),
    );
  });
});
