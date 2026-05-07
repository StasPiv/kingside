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
  // KS-2235 (KS-2231): default `false` — фича в разработке.
  drills: false,
};
vi.mock('../context/FeatureFlagsContext', () => ({
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
  useFeatureFlag: (key: string) => {
    if (key === 'lessonsEnabled') return flagControls.lessons;
    if (key === 'puzzlesEnabled') return flagControls.puzzles;
    if (key === 'broadcastsEnabled') return flagControls.broadcasts;
    if (key === 'tournamentsEnabled') return flagControls.tournaments;
    if (key === 'drillsEnabled') return flagControls.drills;
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
    drillsEnabled: false,
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
  flagControls.drills = false;
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

  it('KS-2235: drillsEnabled=false (default) → пункт «Тренажёры» скрыт', () => {
    flagControls.drills = false;
    renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/drills|тренажёр/i)).not.toBeInTheDocument();
  });

  it('KS-2235: drillsEnabled=true → пункт «Тренажёры» виден и ведёт на /drills', () => {
    flagControls.drills = true;
    renderWithProviders(<Sidebar />);
    const link = screen.getByTitle(/drills|тренажёр/i);
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/drills');
  });

  it('KS-2539: puzzlesEnabled=false → пункт «Тренировка точности» скрыт', () => {
    flagControls.puzzles = false;
    renderWithProviders(<Sidebar />);
    expect(
      screen.queryByTitle(/precision|тренировка точности/i),
    ).not.toBeInTheDocument();
  });

  it('KS-2539: puzzlesEnabled=true → пункт «Тренировка точности» виден и ведёт на /precision', () => {
    flagControls.puzzles = true;
    renderWithProviders(<Sidebar />);
    const link = screen.getByTitle(/precision|тренировка точности/i);
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/precision');
  });

  it('KS-2252: иконка кнопки обратной связи — 📝 (НЕ 💬, чтобы не путалась с ChatWidget)', () => {
    renderWithProviders(<Sidebar />);
    const btn = screen.getByTestId('sidebar-feedback-btn');
    expect(btn).toHaveTextContent('📝');
    // Дополнительно: 💬 нигде не должно быть в Sidebar (ChatWidget — отдельный
    // компонент в MainLayout, и под `assistantEnabled=false` он null).
    expect(btn).not.toHaveTextContent('💬');
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
