import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen } from '../test/test-utils';
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

import { MobileBottomBar } from './MobileBottomBar';

beforeEach(() => {
  flagControls.lessons = true;
  // KS-2218: тесты, где «Задачи» должны быть видимы, явно ставят
  // puzzles=true. Default=false соответствует серверному whitelist.
  flagControls.puzzles = true;
  flagControls.broadcasts = true;
  flagControls.tournaments = true;
  flagControls.drills = false;
  adminControls.isAdmin = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<MobileBottomBar> (KS-2110)', () => {
  it('по умолчанию показывает основные пункты Play/Tournaments/Puzzles/Workshop/More', () => {
    renderWithProviders(<MobileBottomBar />);
    expect(screen.getByText(/play/i)).toBeInTheDocument();
    expect(screen.getByText(/tournaments/i)).toBeInTheDocument();
    expect(screen.getByText(/puzzles/i)).toBeInTheDocument();
    expect(screen.getByText(/workshop/i)).toBeInTheDocument();
    expect(screen.getByText(/more/i)).toBeInTheDocument();
  });

  it('клик «More» → раскрывает меню; виден пункт «Уроки» (lessonsEnabled=true)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);

    expect(screen.queryByTestId('mobile-more-lessons')).not.toBeInTheDocument();

    await user.click(screen.getByText(/more/i));
    expect(screen.getByTestId('mobile-more-lessons')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-lessons').getAttribute('href')).toBe(
      '/lessons',
    );
  });

  it('lessonsEnabled=false → пункт «Уроки» скрыт', async () => {
    flagControls.lessons = false;
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await user.click(screen.getByText(/more/i));
    expect(screen.queryByTestId('mobile-more-lessons')).not.toBeInTheDocument();
  });

  it('KS-2218: tournamentsEnabled=false → таб «Турниры» скрыт', () => {
    flagControls.tournaments = false;
    renderWithProviders(<MobileBottomBar />);
    expect(screen.queryByTestId('mobile-bar-tournaments')).not.toBeInTheDocument();
  });

  it('KS-2218: tournamentsEnabled=true → таб «Турниры» виден', () => {
    flagControls.tournaments = true;
    renderWithProviders(<MobileBottomBar />);
    expect(screen.getByTestId('mobile-bar-tournaments')).toBeInTheDocument();
  });

  it('KS-2218: puzzlesEnabled=false → таб «Задачи» скрыт', () => {
    flagControls.puzzles = false;
    renderWithProviders(<MobileBottomBar />);
    expect(screen.queryByTestId('mobile-bar-puzzles')).not.toBeInTheDocument();
  });

  it('KS-2218: puzzlesEnabled=true → таб «Задачи» виден и ведёт на /daily', () => {
    flagControls.puzzles = true;
    renderWithProviders(<MobileBottomBar />);
    const link = screen.getByTestId('mobile-bar-puzzles');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/daily');
  });

  it('KS-2218: broadcastsEnabled=false → пункт «Трансляции» в more-menu скрыт', async () => {
    flagControls.broadcasts = false;
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await user.click(screen.getByText(/more/i));
    expect(screen.queryByTestId('mobile-more-broadcasts')).not.toBeInTheDocument();
  });

  it('KS-2218: broadcastsEnabled=true → пункт «Трансляции» в more-menu виден', async () => {
    flagControls.broadcasts = true;
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await user.click(screen.getByText(/more/i));
    expect(screen.getByTestId('mobile-more-broadcasts')).toBeInTheDocument();
  });

  it('KS-2235: drillsEnabled=false → пункт «Тренажёры» в more-menu скрыт', async () => {
    flagControls.drills = false;
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await user.click(screen.getByText(/more/i));
    expect(screen.queryByTestId('mobile-more-drills')).not.toBeInTheDocument();
  });

  it('KS-2235: drillsEnabled=true → пункт «Тренажёры» в more-menu виден и ведёт на /drills', async () => {
    flagControls.drills = true;
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await user.click(screen.getByText(/more/i));
    const link = screen.getByTestId('mobile-more-drills');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/drills');
  });

  it('isAdmin=false → пункт «Админка» скрыт; isAdmin=true → виден', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<MobileBottomBar />);
    await user.click(screen.getByText(/more/i));
    expect(screen.queryByTestId('mobile-more-admin')).not.toBeInTheDocument();
    unmount();

    adminControls.isAdmin = true;
    renderWithProviders(<MobileBottomBar />);
    await user.click(screen.getByText(/more/i));
    expect(screen.getByTestId('mobile-more-admin')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-admin').getAttribute('href')).toBe(
      '/admin/feature-flags',
    );
  });
});
