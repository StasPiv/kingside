import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen } from '../test/test-utils';
import userEvent from '@testing-library/user-event';

const flagControls = { lessons: true };
const adminControls = { isAdmin: false };

vi.mock('../context/FeatureFlagsContext', () => ({
  useFeatureFlag: (key: string) =>
    key === 'lessonsEnabled' ? flagControls.lessons : false,
  useFeatureFlags: () => ({
    flags: { lessonsEnabled: flagControls.lessons },
    loading: false,
    error: null,
    refresh: async () => {},
  }),
  FeatureFlagsProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DEFAULT_FLAGS: { lessonsEnabled: true },
}));

vi.mock('../hooks/useAdminStatus', () => ({
  useAdminStatus: () => ({ isAdmin: adminControls.isAdmin, loading: false }),
}));

import { MobileBottomBar } from './MobileBottomBar';

beforeEach(() => {
  flagControls.lessons = true;
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
