import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import React from 'react';

/**
 * KS-2805 (ADR-058 §5.1, §6.3 T8): useNavStats теперь работает с
 * 6 групповыми ключами (play/train/learn/analyze/broadcasts/profile).
 * Тесты переписаны: legacy-ключи (puzzles/drills/precision/workshop/
 * archive/tournaments/puzzle-rush/lessons) больше не в whitelist на
 * фронте, но `useTopNavStats` защитно мапит их на группы если backend
 * вдруг вернул legacy (на случай рассинхрона с KS-2809).
 */

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
  // KS-2823: studies flag добавлен в FeatureFlags. Default false (beta).
  studiesEnabled: false,
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
  DEFAULT_TOP,
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

describe('resolveNavRoute KS-2805 — групповой маппинг', () => {
  it('legacy подразделы → group `train`', () => {
    expect(resolveNavRoute('/puzzles')).toBe('train');
    expect(resolveNavRoute('/puzzle-rush')).toBe('train');
    expect(resolveNavRoute('/puzzle/abc-123')).toBe('train');
    expect(resolveNavRoute('/drills/find-pin')).toBe('train');
    expect(resolveNavRoute('/precision/stats')).toBe('train');
    expect(resolveNavRoute('/train')).toBe('train');
  });

  it('legacy подразделы → group `analyze`', () => {
    expect(resolveNavRoute('/workshop')).toBe('analyze');
    expect(resolveNavRoute('/analysis/xyz')).toBe('analyze');
    expect(resolveNavRoute('/archive/123')).toBe('analyze');
    expect(resolveNavRoute('/analyze')).toBe('analyze');
  });

  it('/play и /tournaments → group `play`', () => {
    expect(resolveNavRoute('/play')).toBe('play');
    expect(resolveNavRoute('/play/some')).toBe('play');
    expect(resolveNavRoute('/tournaments/abc')).toBe('play');
  });

  it('/lessons → group `learn`', () => {
    expect(resolveNavRoute('/lessons')).toBe('learn');
    expect(resolveNavRoute('/lessons/capablanca')).toBe('learn');
  });

  it('/broadcasts и /profile/player', () => {
    expect(resolveNavRoute('/broadcasts/123')).toBe('broadcasts');
    expect(resolveNavRoute('/profile')).toBe('profile');
    expect(resolveNavRoute('/player/tester')).toBe('profile');
  });

  it('null для не-навигационных и для /lobby (главная не в whitelist)', () => {
    expect(resolveNavRoute('/lobby')).toBeNull();
    expect(resolveNavRoute('/')).toBeNull();
    expect(resolveNavRoute('/settings')).toBeNull();
    expect(resolveNavRoute('/game/abc')).toBeNull();
    expect(resolveNavRoute('/feedback')).toBeNull();
    expect(resolveNavRoute('/login')).toBeNull();
  });

  it('NAV_ROUTES содержит ровно 6 групп', () => {
    expect(Object.keys(NAV_ROUTES).sort()).toEqual(
      ['analyze', 'broadcasts', 'learn', 'play', 'profile', 'train'].sort(),
    );
  });

  it('KS-2811: NAV_ROUTES.train.customGate = puzzlesEnabled || drillsEnabled', () => {
    const meta = NAV_ROUTES.train;
    expect(meta.customGate).toBeDefined();
    // Оба false → скрыта.
    expect(
      meta.customGate!({
        ...flagsState,
        puzzlesEnabled: false,
        drillsEnabled: false,
      }),
    ).toBe(false);
    // Хотя бы один true → видна.
    expect(
      meta.customGate!({
        ...flagsState,
        puzzlesEnabled: true,
        drillsEnabled: false,
      }),
    ).toBe(true);
    expect(
      meta.customGate!({
        ...flagsState,
        puzzlesEnabled: false,
        drillsEnabled: true,
      }),
    ).toBe(true);
  });

  it('DEFAULT_TOP — три первые группы по ADR-058 §5.1', () => {
    expect(DEFAULT_TOP).toEqual(['play', 'train', 'learn']);
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

describe('useTrackNavStats — групповой инкремент (KS-2805)', () => {
  it('после 3.5с pathname /drills/find-pin → POST { route: "train" }', () => {
    vi.useFakeTimers();
    renderHook(() => useTrackNavStats(), {
      wrapper: makeWrapper('/drills/find-pin'),
    });
    expect(apiPostMock).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(apiPostMock).toHaveBeenCalledWith(
      '/user/nav-stats/increment',
      { route: 'train' },
    );
  });

  it('pathname /workshop → POST { route: "analyze" }', () => {
    vi.useFakeTimers();
    renderHook(() => useTrackNavStats(), { wrapper: makeWrapper('/workshop') });
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(apiPostMock).toHaveBeenCalledWith(
      '/user/nav-stats/increment',
      { route: 'analyze' },
    );
  });

  it('pathname /tournaments/abc → POST { route: "play" }', () => {
    vi.useFakeTimers();
    renderHook(() => useTrackNavStats(), {
      wrapper: makeWrapper('/tournaments/abc'),
    });
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(apiPostMock).toHaveBeenCalledWith(
      '/user/nav-stats/increment',
      { route: 'play' },
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

  it('unauth → POST не вызывается', () => {
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
    await Promise.resolve();
    expect(apiPostMock).toHaveBeenCalled();
  });
});

describe('useTopNavStats — групповой набор + защитный legacy-маппинг (KS-2805)', () => {
  it('backend вернул групповые ключи → отдаём как есть', async () => {
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'train', count: 10 },
        { route: 'play', count: 7 },
        { route: 'analyze', count: 4 },
      ],
    });
    const { result } = renderHook(() => useTopNavStats(3), {
      wrapper: makeWrapper('/'),
    });
    await waitFor(() => expect(result.current.routes.length).toBe(3));
    expect(result.current.routes).toEqual(['train', 'play', 'analyze']);
  });

  it('backend вернул legacy-ключи → маппим на группы (защита от рассинхрона)', async () => {
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'puzzles', count: 10 }, // → train
        { route: 'workshop', count: 7 }, // → analyze
        { route: 'tournaments', count: 4 }, // → play
      ],
    });
    const { result } = renderHook(() => useTopNavStats(3), {
      wrapper: makeWrapper('/'),
    });
    await waitFor(() => expect(result.current.routes.length).toBe(3));
    expect(result.current.routes).toEqual(['train', 'analyze', 'play']);
  });

  it('legacy + group в одном ответе → дедупликация (первая запись побеждает)', async () => {
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'puzzles', count: 100 }, // → train (попадает первым)
        { route: 'train', count: 50 }, // уже видели — игнор
        { route: 'workshop', count: 30 }, // → analyze
      ],
    });
    const { result } = renderHook(() => useTopNavStats(3), {
      wrapper: makeWrapper('/'),
    });
    await waitFor(() => expect(result.current.routes.length).toBe(2));
    expect(result.current.routes).toEqual(['train', 'analyze']);
  });

  it('неизвестные ключи отбрасываются', async () => {
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'unknown-key', count: 99 },
        { route: 'train', count: 5 },
      ],
    });
    const { result } = renderHook(() => useTopNavStats(3), {
      wrapper: makeWrapper('/'),
    });
    await waitFor(() => expect(result.current.routes.length).toBe(1));
    expect(result.current.routes).toEqual(['train']);
  });

  it('feature-flag gate: broadcastsEnabled=false → broadcasts отброшен', async () => {
    flagsState.broadcastsEnabled = false;
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'broadcasts', count: 100 },
        { route: 'play', count: 5 },
        { route: 'analyze', count: 3 },
      ],
    });
    const { result } = renderHook(() => useTopNavStats(3), {
      wrapper: makeWrapper('/'),
    });
    await waitFor(() => expect(result.current.routes.length).toBe(2));
    expect(result.current.routes).toEqual(['play', 'analyze']);
  });

  it('KS-2811: train скрыта в /top если puzzles+drills=false', async () => {
    flagsState.puzzlesEnabled = false;
    flagsState.drillsEnabled = false;
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'train', count: 10 },
        { route: 'play', count: 5 },
      ],
    });
    const { result } = renderHook(() => useTopNavStats(3), {
      wrapper: makeWrapper('/'),
    });
    await waitFor(() => expect(result.current.routes.length).toBe(1));
    expect(result.current.routes).toEqual(['play']);
  });

  it('запрашивает limit*3 (запас на gating)', async () => {
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
