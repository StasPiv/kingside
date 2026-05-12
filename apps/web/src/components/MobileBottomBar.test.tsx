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

  it('KS-2811: group `train` скрыта когда puzzles+drills=false (Rush через прямой URL)', async () => {
    flagControls.puzzles = false;
    flagControls.drills = false;
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('mobile-bar-train')).not.toBeInTheDocument();
  });

  it('KS-2811: group `train` видна если хотя бы один из puzzles/drills включён', async () => {
    flagControls.puzzles = false;
    flagControls.drills = true;
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

/**
 * KS-2807 (ADR-058 §5.2, §6.3 T10): drawer «Ещё» теперь сгруппирован
 * (Разделы / Социум / Аккаунт / Помощь / Админ). Тестируем разметку
 * групп и попадание правильных ссылок в них.
 */
describe('<MobileBottomBar> KS-2807 — drawer группировка', () => {
  it('drawer содержит группу «Социум» с broadcasts и friends', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(screen.getByTestId('mobile-more-group-social')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-broadcasts')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-friends')).toBeInTheDocument();
    expect(
      screen.getByTestId('mobile-more-broadcasts').getAttribute('href'),
    ).toBe('/broadcasts');
    expect(
      screen.getByTestId('mobile-more-friends').getAttribute('href'),
    ).toBe('/friends');
  });

  it('drawer содержит группу «Аккаунт» с profile и settings', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(screen.getByTestId('mobile-more-group-account')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-profile')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-settings')).toBeInTheDocument();
  });

  it('drawer содержит группу «Помощь» с features и feedback (кнопка-модалка)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(screen.getByTestId('mobile-more-group-help')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-features')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-features').getAttribute('href')).toBe('/features');
    // Feedback — кнопка-модалка, не <a>.
    const feedbackBtn = screen.getByTestId('mobile-more-feedback');
    expect(feedbackBtn.tagName).toBe('BUTTON');
    expect(feedbackBtn.getAttribute('href')).toBeNull();
  });

  it('группа «Админ» видна ТОЛЬКО админу', async () => {
    const user = userEvent.setup();
    adminControls.isAdmin = false;
    const { unmount } = renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(
      screen.queryByTestId('mobile-more-group-admin'),
    ).not.toBeInTheDocument();
    unmount();

    adminControls.isAdmin = true;
    apiGetMock.mockResolvedValue({ items: [] });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(screen.getByTestId('mobile-more-group-admin')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-admin').getAttribute('href')).toBe(
      '/admin/feature-flags',
    );
  });

  /**
   * KS-2919 — регрессия Stanislav. На обоих контейнерах (Sidebar +
   * MobileBottomBar) пропадала «Админка», хотя гейты в коде корректны
   * и тестами покрыты. Источник — runtime: `useAdminStatus` возвращал
   * false (см. фикс в hooks/useAdminStatus.ts — добавлен whitelist
   * по username). Защита от регрессии разметки: гарантируем, что
   * пункт реально лежит в группе `mobile-more-group-admin` и href ведёт
   * на `/admin/feature-flags`.
   */
  it('KS-2919: isAdmin=true → ссылка лежит в группе admin с правильным href', async () => {
    const user = userEvent.setup();
    adminControls.isAdmin = true;
    apiGetMock.mockResolvedValue({ items: [] });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    const group = screen.getByTestId('mobile-more-group-admin');
    const link = screen.getByTestId('mobile-more-admin');
    expect(group.contains(link)).toBe(true);
    expect(link.getAttribute('href')).toBe('/admin/feature-flags');
  });

  it('KS-2919: isAdmin=false → группа admin отсутствует, прочие группы drawer на месте', async () => {
    const user = userEvent.setup();
    adminControls.isAdmin = false;
    apiGetMock.mockResolvedValue({ items: [] });
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(
      screen.queryByTestId('mobile-more-group-admin'),
    ).not.toBeInTheDocument();
    // Остальные группы drawer'а не должны пострадать.
    expect(screen.getByTestId('mobile-more-group-help')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-group-account')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-group-social')).toBeInTheDocument();
  });

  it('broadcasts в top-3 → дублируется в группе «Социум» нет, остается friends', async () => {
    apiGetMock.mockResolvedValue({
      items: [
        { route: 'broadcasts', count: 30 },
        { route: 'play', count: 20 },
        { route: 'train', count: 10 },
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-broadcasts')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('mobile-bar-more'));
    // broadcasts уже в bar — в drawer группе «Социум» только friends.
    expect(
      screen.queryByTestId('mobile-more-broadcasts'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-friends')).toBeInTheDocument();
    // Группа «Социум» всё ещё рендерится (есть friends).
    expect(screen.getByTestId('mobile-more-group-social')).toBeInTheDocument();
  });

  it('секция «Разделы» — group-routes не из top-3 и НЕ broadcasts/profile', async () => {
    // DEFAULT_TOP = play/train/learn → в drawer-«Разделах» только analyze.
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(
      screen.getByTestId('mobile-more-group-sections'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('mobile-more-analyze')).toBeInTheDocument();
    // broadcasts/profile — в своих группах, НЕ в «Разделах».
    const sectionsGroup = screen.getByTestId('mobile-more-group-sections');
    expect(
      sectionsGroup.querySelector('[data-testid="mobile-more-broadcasts"]'),
    ).toBeNull();
    expect(
      sectionsGroup.querySelector('[data-testid="mobile-more-profile"]'),
    ).toBeNull();
  });

  it('Главная (/lobby) и Турниры (/tournaments) — НЕ в drawer (KS-2807)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MobileBottomBar />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('mobile-bar-more'));
    expect(screen.queryByText(/^Home$|^Главная$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Tournaments$|^Турниры$/i)).not.toBeInTheDocument();
  });
});

/**
 * KS-2812 (ADR-058 §6.6 T15): active highlight на nested-маршрутах
 * mobile bottom bar. Группа подсвечивается при заходе в любой из её
 * подразделов (паттерн из useNavStats.matches).
 */
describe('<MobileBottomBar> KS-2812 — active highlight на nested-routes', () => {
  it('на /puzzles подсвечен mobile-bar-train', async () => {
    flagControls.puzzles = true;
    renderWithProviders(<MobileBottomBar />, { route: '/puzzles' });
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-train')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-train').className).toContain(
      'mobile-bar-item--active',
    );
  });

  it('на /precision/stats подсвечен mobile-bar-train (nested)', async () => {
    flagControls.puzzles = true;
    renderWithProviders(<MobileBottomBar />, { route: '/precision/stats' });
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-train')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-train').className).toContain(
      'mobile-bar-item--active',
    );
  });

  it('на /tournaments подсвечен mobile-bar-play (группа)', async () => {
    renderWithProviders(<MobileBottomBar />, { route: '/tournaments' });
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-play').className).toContain(
      'mobile-bar-item--active',
    );
  });

  it('на /lessons/some-slug подсвечен mobile-bar-learn', async () => {
    renderWithProviders(<MobileBottomBar />, { route: '/lessons/slug' });
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-learn')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-learn').className).toContain(
      'mobile-bar-item--active',
    );
  });

  it('на /play подсвечен только mobile-bar-play (других не задевает)', async () => {
    renderWithProviders(<MobileBottomBar />, { route: '/play' });
    await waitFor(() =>
      expect(screen.getByTestId('mobile-bar-play')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mobile-bar-play').className).toContain(
      'mobile-bar-item--active',
    );
    flagControls.puzzles = true;
    // train не должна быть active
    expect(
      screen.queryByTestId('mobile-bar-train')?.className ?? '',
    ).not.toContain('mobile-bar-item--active');
  });
});

