import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';

// KS-2105: Sidebar читает флаги из FeatureFlagsContext (runtime,
// backend `GET /config`). Мокаем сам контекст-хук — это позволяет
// переключать флаг в тестах без рендера Provider'а и без сетевого мока.
const flagControls = { lessons: true };
vi.mock('../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({
    flags: { lessonsEnabled: flagControls.lessons },
    loading: false,
    error: null,
    refresh: async () => {},
  }),
  useFeatureFlag: (key: string) =>
    key === 'lessonsEnabled' ? flagControls.lessons : false,
  FeatureFlagsProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DEFAULT_FLAGS: { lessonsEnabled: true },
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
