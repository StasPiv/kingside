import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import userEvent from '@testing-library/user-event';

import { AdminFeatureFlagsPage } from './AdminFeatureFlagsPage';

/**
 * KS-2109: тесты страницы /admin/feature-flags.
 *
 * Покрытие:
 *   • Не-админ — компонент редиректит (рендерит Navigate).
 *   • Админ — список загружается из `listAdminFeatureFlags`.
 *   • Клик по тумблеру → PATCH с противоположным значением,
 *     локальное обновление строки и refresh публичных флагов.
 *   • Ошибка PATCH — выводится в data-testid `…-save-error`.
 */

const adminApi = {
  listAdminFeatureFlags: vi.fn(),
  updateFeatureFlag: vi.fn(),
};

vi.mock('../api/configApi', () => ({
  configApi: {
    listAdminFeatureFlags: (...a: unknown[]) =>
      adminApi.listAdminFeatureFlags(...a),
    updateFeatureFlag: (...a: unknown[]) => adminApi.updateFeatureFlag(...a),
  },
}));

const adminControl = { isAdmin: true, loading: false };
vi.mock('../hooks/useAdminStatus', () => ({
  useAdminStatus: () => adminControl,
}));

const refreshPublic = vi.fn();
vi.mock('../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({
    flags: { lessonsEnabled: true },
    loading: false,
    error: null,
    refresh: (...a: unknown[]) => refreshPublic(...a),
  }),
  useFeatureFlag: () => true,
  FeatureFlagsProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DEFAULT_FLAGS: { lessonsEnabled: true },
}));

beforeEach(() => {
  adminApi.listAdminFeatureFlags.mockReset();
  adminApi.updateFeatureFlag.mockReset();
  refreshPublic.mockReset();
  adminControl.isAdmin = true;
  adminControl.loading = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdminFeatureFlagsPage', () => {
  it('не-админ → редирект (страница не рендерится)', () => {
    adminControl.isAdmin = false;
    renderWithProviders(<AdminFeatureFlagsPage />, {
      route: '/admin/feature-flags',
    });
    // Страница не должна показаться. Navigate в MemoryRouter перебросит
    // на корень, где у нас нет рута — render остаётся пустым,
    // достаточно проверить что заголовка/таблицы нет.
    expect(
      screen.queryByTestId('admin-feature-flags-page'),
    ).not.toBeInTheDocument();
  });

  it('админ → грузит список и рендерит тумблеры', async () => {
    adminApi.listAdminFeatureFlags.mockResolvedValueOnce([
      {
        key: 'lessonsEnabled',
        value: true,
        defaultValue: true,
        description: 'Lessons section visibility',
        updatedAt: '2026-04-28T12:00:00.000Z',
      },
    ]);
    renderWithProviders(<AdminFeatureFlagsPage />, {
      route: '/admin/feature-flags',
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('admin-feature-flag-row-lessonsEnabled'),
      ).toBeInTheDocument(),
    );
    const toggle = screen.getByTestId(
      'admin-feature-flag-toggle-lessonsEnabled',
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText(/Lessons section visibility/)).toBeInTheDocument();
  });

  it('клик по тумблеру → PATCH с противоположным значением + refresh', async () => {
    adminApi.listAdminFeatureFlags.mockResolvedValueOnce([
      {
        key: 'lessonsEnabled',
        value: true,
        defaultValue: true,
        description: 'Lessons',
        updatedAt: '2026-04-28T12:00:00.000Z',
      },
    ]);
    adminApi.updateFeatureFlag.mockResolvedValueOnce({
      key: 'lessonsEnabled',
      value: false,
      updatedAt: '2026-04-28T12:01:00.000Z',
    });
    const user = userEvent.setup();

    renderWithProviders(<AdminFeatureFlagsPage />, {
      route: '/admin/feature-flags',
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('admin-feature-flag-toggle-lessonsEnabled'),
      ).toBeInTheDocument(),
    );

    await user.click(
      screen.getByTestId('admin-feature-flag-toggle-lessonsEnabled'),
    );

    await waitFor(() =>
      expect(adminApi.updateFeatureFlag).toHaveBeenCalledWith(
        'lessonsEnabled',
        { value: false },
      ),
    );

    // Локальное обновление: новый updatedAt + value=false → checkbox unchecked.
    await waitFor(() => {
      const toggle = screen.getByTestId(
        'admin-feature-flag-toggle-lessonsEnabled',
      ) as HTMLInputElement;
      expect(toggle.checked).toBe(false);
    });
    expect(
      screen.getByTestId('admin-feature-flag-saved-lessonsEnabled'),
    ).toBeInTheDocument();
    // Глобальный FeatureFlagsContext инвалидируется — Sidebar/App увидят.
    expect(refreshPublic).toHaveBeenCalled();
  });

  it('ошибка PATCH → отображает save-error', async () => {
    adminApi.listAdminFeatureFlags.mockResolvedValueOnce([
      {
        key: 'lessonsEnabled',
        value: true,
        defaultValue: true,
        description: null,
        updatedAt: null,
      },
    ]);
    adminApi.updateFeatureFlag.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();

    renderWithProviders(<AdminFeatureFlagsPage />, {
      route: '/admin/feature-flags',
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('admin-feature-flag-toggle-lessonsEnabled'),
      ).toBeInTheDocument(),
    );

    await user.click(
      screen.getByTestId('admin-feature-flag-toggle-lessonsEnabled'),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('admin-feature-flags-save-error'),
      ).toBeInTheDocument(),
    );
    expect(refreshPublic).not.toHaveBeenCalled();
  });
});
