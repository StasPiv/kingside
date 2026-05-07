import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen } from '../test/test-utils';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const flagControls = {
  lessons: true,
  // KS-2218: дефолты повторяют backend whitelist (KS-2217).
  puzzles: false,
  broadcasts: true,
  tournaments: true,
  // KS-2235 (KS-2231): default `false`.
  drills: false,
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

// KS-2373: useTopNavStats читает /user/nav-stats/top через api.get.
// Auth должен присутствовать иначе хук вернёт [].
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
  // По умолчанию backend возвращает пустой топ → дефолт.
  apiGetMock.mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<MobileBottomBar> (KS-2110 + KS-2373)', () => {
  it('пустой топ → дефолт Play / Tournaments / Workshop + More', async () => {
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(
        expect.stringContaining('/user/nav-stats/top?limit='),
      ),
    );
    expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-tournaments')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-workshop')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-more')).toBeInTheDocument();
  });

  it('KS-2373: топ от API содержит drills → /drills в bar (drillsEnabled=true)', async () => {
    flagControls.drills = true;
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'drills', count: 45 },
        { route: 'archive', count: 12 },
        { route: 'workshop', count: 8 },
      ],
    });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-drills')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-archive')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-workshop')).toBeInTheDocument();
    // Play вытеснился из bar в more.
    expect(screen.queryByTestId('mobile-bar-play')).not.toBeInTheDocument();
  });

  it('KS-2552: precision в top-3 от API → /precision в bar (puzzlesEnabled=true)', async () => {
    flagControls.puzzles = true;
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'workshop', count: 30 },
        { route: 'puzzles', count: 25 },
        { route: 'precision', count: 21 },
      ],
    });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-precision')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-workshop')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-puzzles')).toBeInTheDocument();
    // Play вытеснен из bar (top-3 заняты другими).
    expect(screen.queryByTestId('mobile-bar-play')).not.toBeInTheDocument();
  });

  it('KS-2552: precision в top-3, но puzzlesEnabled=false → отфильтровывается', async () => {
    flagControls.puzzles = false;
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'precision', count: 50 },
        { route: 'workshop', count: 30 },
        { route: 'play', count: 20 },
        { route: 'archive', count: 5 },
      ],
    });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-workshop')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('mobile-bar-precision')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-archive')).toBeInTheDocument();
  });

  it('KS-2373: топ-роут с выключенным feature-flag отбрасывается', async () => {
    flagControls.drills = false; // drills выключены
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'drills', count: 99 }, // отфильтруется
        { route: 'play', count: 5 },
        { route: 'archive', count: 3 },
        { route: 'workshop', count: 2 },
      ],
    });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('mobile-bar-drills')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-archive')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-workshop')).toBeInTheDocument();
  });

  it('клик «More» → раскрывает меню; виден пункт «Lessons» (lessonsEnabled=true)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalled(),
    );
    expect(screen.queryByTestId('mobile-more-lessons')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(screen.getByTestId('mobile-more-lessons')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-lessons').getAttribute('href')).toBe(
      '/lessons',
    );
  });

  it('lessonsEnabled=false → пункт «Уроки» в more скрыт', async () => {
    flagControls.lessons = false;
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(screen.queryByTestId('mobile-more-lessons')).not.toBeInTheDocument();
  });

  it('KS-2218: tournamentsEnabled=false → /tournaments не в bar и не в more', async () => {
    flagControls.tournaments = false;
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(
      screen.queryByTestId('mobile-bar-tournaments'),
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(
      screen.queryByTestId('mobile-more-tournaments'),
    ).not.toBeInTheDocument();
  });

  it('KS-2218: puzzlesEnabled=true → /puzzles доступен через more (если не в топе)', async () => {
    flagControls.puzzles = true;
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    const link = screen.getByTestId('mobile-more-puzzles');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/daily');
  });

  it('KS-2235: drillsEnabled=true → /drills в more, если не в топе', async () => {
    flagControls.drills = true;
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(screen.getByTestId('mobile-more-drills')).toBeInTheDocument();
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

  it('KS-2373: GET ошибка → дефолт без падения', async () => {
    apiGetMock.mockRejectedValue(new Error('boom'));
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-tournaments')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-bar-workshop')).toBeInTheDocument();
  });
});
