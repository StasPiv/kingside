import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen } from '../test/test-utils';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * KS-2806 (ADR-058 §5.1, §6.3 T9): MobileBottomBar теперь работает с
 * групповым whitelist'ом из useNavStats (KS-2805). Тесты переписаны:
 * legacy-ключи (drills, puzzles, precision, tournaments, workshop,
 * archive) больше не существуют как top-level data-testid'ы — вместо
 * них групповые `mobile-bar-{play,train,learn,analyze,broadcasts,profile}`.
 */

const flagControls = {
  lessons: true,
  puzzles: true,
  broadcasts: true,
  tournaments: true,
  drills: true,
};
const adminControls = { isAdmin: false };

vi.mock('../context/FeatureFlagsContext', () => ({
  useFeatureFlag: (key: string) => {
    if (key === 'lessonsEnabled') return flagControls.lessons;
    if (key === 'puzzlesEnabled') return flagControls.puzzles;
    if (key === 'broadcastsEnabled') return flagControls.broadcasts;
    if (key === 'tournamentsEnabled') return flagControls.tournaments;
    if (key === 'drillsEnabled') return flagControls.drills;
    return false;
  },
  useFeatureFlags: () => ({
    flags: {
      lessonsEnabled: flagControls.lessons,
      puzzlesEnabled: flagControls.puzzles,
      broadcastsEnabled: flagControls.broadcasts,
      tournamentsEnabled: flagControls.tournaments,
      drillsEnabled: flagControls.drills,
    },
    loading: false,
    error: null,
    refresh: async () => {},
  }),
  FeatureFlagsProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DEFAULT_FLAGS: {
    lessonsEnabled: true,
    puzzlesEnabled: false,
    broadcastsEnabled: true,
    tournamentsEnabled: true,
    drillsEnabled: false,
  },
}));

vi.mock('../hooks/useAdminStatus', () => ({
  useAdminStatus: () => ({ isAdmin: adminControls.isAdmin, loading: false }),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'tester', loading: false },
    loading: false,
  }),
}));

const apiGetMock = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (path: string) => apiGetMock(path),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}));

import { MobileBottomBar } from './MobileBottomBar';

beforeEach(() => {
  flagControls.lessons = true;
  flagControls.puzzles = true;
  flagControls.broadcasts = true;
  flagControls.tournaments = true;
  flagControls.drills = false;
  adminControls.isAdmin = false;
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<MobileBottomBar> KS-2806 — групповой набор', () => {
  it('пустой топ → DEFAULT_TOP = Play / Train / Learn + More', async () => {
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(
        expect.stringContaining('/user/nav-stats/top?limit='),
      ),
    );
    expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-train')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-learn')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-more')).toBeInTheDocument();
  });

  it('backend вернул групповые топ-ключи → они отображаются', async () => {
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'analyze', count: 30 },
        { route: 'broadcasts', count: 20 },
        { route: 'profile', count: 10 },
      ],
    });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-analyze')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-broadcasts')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-profile')).toBeInTheDocument();
    // play/train/learn вытеснены.
    expect(screen.queryByTestId('mobile-bar-play')).not.toBeInTheDocument();
  });

  it('backend вернул legacy → map в группу (защита от рассинхрона)', async () => {
    flagControls.drills = true;
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'drills', count: 30 },
        { route: 'workshop', count: 20 },
        { route: 'tournaments', count: 10 },
      ],
    });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-train')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-analyze')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument();
  });

  it('lessonsEnabled=false → group `learn` отбрасывается, добор из других групп', async () => {
    flagControls.lessons = false;
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('mobile-bar-learn')).not.toBeInTheDocument();
    // добор: analyze (без gating)
    expect(screen.getByTestId('mobile-bar-train')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-analyze')).toBeInTheDocument();
  });

  it('broadcastsEnabled=false → group `broadcasts` отбрасывается даже если в top-API', async () => {
    flagControls.broadcasts = false;
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'broadcasts', count: 100 },
        { route: 'play', count: 5 },
        { route: 'analyze', count: 3 },
      ],
    });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('mobile-bar-broadcasts')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-analyze')).toBeInTheDocument();
  });

  it('group `train` видна даже при puzzles+drills=false (customGate, Rush открыт)', async () => {
    flagControls.puzzles = false;
    flagControls.drills = false;
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-train')).toBeInTheDocument(),
    );
  });

  it('клик «More» → видны Profile/Analyze/Broadcasts в drawer (то, что не в топе)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(screen.queryByTestId('mobile-more-analyze')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('mobile-bar-more'));
    // DEFAULT_TOP = [play, train, learn] → в drawer падают analyze,
    // broadcasts, profile.
    expect(screen.getByTestId('mobile-more-analyze')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-broadcasts')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-profile')).toBeInTheDocument();
  });

  it('isAdmin=true → пункт «Админка» виден в more', async () => {
    const user = userEvent.setup();
    adminControls.isAdmin = true;
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(screen.getByTestId('mobile-more-admin')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-admin').getAttribute('href')).toBe(
      '/admin/feature-flags',
    );
  });

  it('GET ошибка → fallback DEFAULT_TOP без падения', async () => {
    apiGetMock.mockRejectedValue(new Error('boom'));
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-train')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-learn')).toBeInTheDocument();
  });

  it('mobile-bar-train ведёт на /train', async () => {
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-train')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-train').getAttribute('href')).toBe('/train');
  });

  it('mobile-bar-analyze ведёт на /analyze (когда попадает в bar)', async () => {
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'analyze', count: 10 },
        { route: 'play', count: 5 },
        { route: 'train', count: 3 },
      ],
    });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-analyze')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-analyze').getAttribute('href')).toBe('/analyze');
  });

  it('regression KS-2806: топ-роут не падает на отсутствующий NAV_ROUTES[key] (защита)', async () => {
    // Гипотетический сценарий: backend вернул ключ вне whitelist'а — фильтр в useTopNavStats его отбросит,
    // компонент не упадёт.
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'something-unknown', count: 99 },
        { route: 'play', count: 5 },
      ],
    });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument(),
    );
    // Bar не пустой, нет ошибки рендера.
    expect(screen.getByTestId('mobile-bottom-bar')).toBeInTheDocument();
  });
});
