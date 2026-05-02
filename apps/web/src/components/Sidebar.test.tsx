import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';

// KS-2105/KS-2218: Sidebar читает флаги из FeatureFlagsContext (runtime,
// backend `GET /config`). Мокаем сам контекст-хук — это позволяет
// переключать флаги в тестах без рендера Provider'а и без сетевого мока.
const flagControls = {
  lessons: true,
  // KS-2218: дефолты совпадают с серверным whitelist.
  puzzles: false,
  broadcasts: true,
  tournaments: true,
};
vi.mock('../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({
    flags: {
      lessonsEnabled: flagControls.lessons,
      puzzlesEnabled: flagControls.puzzles,
      broadcastsEnabled: flagControls.broadcasts,
      tournamentsEnabled: flagControls.tournaments,
    },
    loading: false,
    error: null,
    refresh: async () => {},
  }),
  useFeatureFlag: (key: string) => {
    if (key === 'lessonsEnabled') return flagControls.lessons;
    if (key === 'puzzlesEnabled') return flagControls.puzzles;
    if (key === 'broadcastsEnabled') return flagControls.broadcasts;
    if (key === 'tournamentsEnabled') return flagControls.tournaments;
    return false;
  },
  FeatureFlagsProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DEFAULT_FLAGS: {
    lessonsEnabled: true,
    puzzlesEnabled: false,
    broadcastsEnabled: true,
    tournamentsEnabled: true,
  },
}));

// FeedbackModal зависит от api-запроса, для теста сайдбара не нужен.
vi.mock('./FeedbackModal', () => ({
  FeedbackModal: () => <div data-testid="feedback-modal-mock" />,
}));

// KS-2109: пункт «Админка» зависит от useAdminStatus.
const adminControls = { isAdmin: false };
vi.mock('../hooks/useAdminStatus', () => ({
  useAdminStatus: () => ({ isAdmin: adminControls.isAdmin, loading: false }),
}));

import { Sidebar } from './Sidebar';

beforeEach(() => {
  flagControls.lessons = true;
  flagControls.puzzles = false;
  flagControls.broadcasts = true;
  flagControls.tournaments = true;
  adminControls.isAdmin = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<Sidebar>', () => {
  it('флаг on → пункт «Уроки» виден в меню', () => {
    flagControls.lessons = true;
    renderWithProviders(<Sidebar />);
    expect(screen.getByTitle(/lessons|уроки/i)).toBeInTheDocument();
  });

  it('флаг off → пункт «Уроки» скрыт', () => {
    flagControls.lessons = false;
    renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/lessons|уроки/i)).not.toBeInTheDocument();
  });

  it('остальные пункты меню на месте при флаге off', () => {
    flagControls.lessons = false;
    renderWithProviders(<Sidebar />);
    // Несколько непересекающихся пунктов — они никак не зависят от флага.
    expect(screen.getByTitle(/play/i)).toBeInTheDocument();
    expect(screen.getByTitle(/workshop|мастерская/i)).toBeInTheDocument();
    expect(screen.getByTitle(/settings|настройки/i)).toBeInTheDocument();
  });

  it('KS-2218: puzzlesEnabled=false (default) → пункт «Задачи» скрыт', () => {
    flagControls.puzzles = false;
    renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/puzzles|задачи/i)).not.toBeInTheDocument();
  });

  it('KS-2218: puzzlesEnabled=true → пункт «Задачи» виден', () => {
    flagControls.puzzles = true;
    renderWithProviders(<Sidebar />);
    expect(screen.getByTitle(/puzzles|задачи/i)).toBeInTheDocument();
  });

  it('KS-2218: broadcastsEnabled=false → пункт «Трансляции» скрыт', () => {
    flagControls.broadcasts = false;
    renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/tv|трансляц/i)).not.toBeInTheDocument();
  });

  it('KS-2218: broadcastsEnabled=true → пункт «Трансляции» виден', () => {
    flagControls.broadcasts = true;
    renderWithProviders(<Sidebar />);
    expect(screen.getByTitle(/tv|трансляц/i)).toBeInTheDocument();
  });

  it('KS-2218: tournamentsEnabled=false → пункт «Турниры» скрыт', () => {
    flagControls.tournaments = false;
    renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/tournaments|турнир/i)).not.toBeInTheDocument();
  });

  it('KS-2218: tournamentsEnabled=true → пункт «Турниры» виден', () => {
    flagControls.tournaments = true;
    renderWithProviders(<Sidebar />);
    expect(screen.getByTitle(/tournaments|турнир/i)).toBeInTheDocument();
  });

  it('KS-2109: пункт «Админка» виден ТОЛЬКО админам', () => {
    adminControls.isAdmin = false;
    const { unmount } = renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/admin|админка/i)).not.toBeInTheDocument();
    unmount();

    adminControls.isAdmin = true;
    renderWithProviders(<Sidebar />);
    const adminLink = screen.getByTitle(/admin|админка/i);
    expect(adminLink).toBeInTheDocument();
    expect(adminLink.getAttribute('href')).toBe('/admin/feature-flags');
  });
});
