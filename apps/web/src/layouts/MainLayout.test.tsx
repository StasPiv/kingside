import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen } from '../test/test-utils';
import { MainLayout } from './MainLayout';

const mockUseAuth = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

// ChatWidget depends on ChatProvider (not mounted in this test harness) and
// keeps an open SSE stream / setInterval that leaks past teardown.
// KS-4287: рендерим маркер вместо `null`, чтобы можно было проверить
// само наличие компонента в DOM на одних роутах и его отсутствие на
// странице партии (`hideAssistantFab`).
vi.mock('../components/ChatWidget', () => ({
  ChatWidget: () => <div data-testid="chat-widget-mock" />,
}));

// Prevent MainLayout's polling `useEffect`s (`fetch('/version.json')`,
// `fetch('/players/online')`, `api.get('/messages/unread-count')`) from
// leaving pending requests that happy-dom will abort on teardown.
vi.mock('../api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ count: 0 }),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../hooks/useChallenge', () => ({
  useChallenge: () => ({ incoming: null, acceptChallenge: vi.fn(), declineChallenge: vi.fn() }),
}));

vi.mock('../hooks/useNotifications', () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    loading: false,
    fetchNotifications: vi.fn(),
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
  }),
}));

vi.mock('../hooks/useActiveGame', () => ({
  useActiveGame: () => ({ activeGame: null }),
}));

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
  }) as unknown as typeof fetch;
});

describe('KS-633: навигация — убрать Train, Login/Register, добавить соцсети', () => {
  describe('неавторизованный пользователь', () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({
        user: null,
        loading: false,
        logout: vi.fn(),
      });
    });

    it('пункт Train отсутствует в навигации', () => {
      renderWithProviders(<MainLayout />, { route: '/lobby' });
      expect(screen.queryByText('Train')).not.toBeInTheDocument();
    });

    it('кнопки Login и Register отсутствуют', () => {
      renderWithProviders(<MainLayout />, { route: '/lobby' });
      expect(screen.queryByText('Login')).not.toBeInTheDocument();
      expect(screen.queryByText('Register')).not.toBeInTheDocument();
    });

    it('отображаются кнопки входа через Google, Facebook, Telegram', () => {
      renderWithProviders(<MainLayout />, { route: '/lobby' });
      expect(screen.getByLabelText('Google')).toBeInTheDocument();
      expect(screen.getByLabelText('Facebook')).toBeInTheDocument();
      expect(screen.getByLabelText('Telegram')).toBeInTheDocument();
    });

    it('кнопки соцсетей ведут на OAuth эндпоинты', () => {
      renderWithProviders(<MainLayout />, { route: '/lobby' });
      const google = screen.getByLabelText('Google');
      const facebook = screen.getByLabelText('Facebook');

      expect(google).toHaveAttribute('href', expect.stringContaining('/auth/google'));
      expect(facebook).toHaveAttribute('href', expect.stringContaining('/auth/facebook'));
    });

    it('кнопка Telegram использует onClick для OAuth редиректа', () => {
      renderWithProviders(<MainLayout />, { route: '/lobby' });
      const telegram = screen.getByLabelText('Telegram');

      expect(telegram).toHaveAttribute('href', '#');
      expect(telegram).toBeInTheDocument();
    });
  });

  describe('авторизованный пользователь', () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({
        user: { id: 'u1', username: 'TestUser', ratingBlitz: 1500 },
        loading: false,
        logout: vi.fn(),
      });
    });

    it('пункт Train отсутствует в навигации', () => {
      renderWithProviders(<MainLayout />, { route: '/lobby' });
      expect(screen.queryByText('Train')).not.toBeInTheDocument();
    });

    it('кнопки соцсетей не отображаются для авторизованного пользователя', () => {
      renderWithProviders(<MainLayout />, { route: '/lobby' });
      expect(screen.queryByLabelText('Google')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Facebook')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Telegram')).not.toBeInTheDocument();
    });
  });
});

describe('KS-4287 / ADR-134 §5: AI ChatWidget скрыт на странице партии', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'TestUser', ratingBlitz: 1500 },
      loading: false,
      logout: vi.fn(),
    });
  });

  it('на обычной странице ChatWidget смонтирован', () => {
    renderWithProviders(<MainLayout />, { route: '/lobby' });
    expect(screen.queryByTestId('chat-widget-mock')).toBeInTheDocument();
  });

  it('на /game/:id ChatWidget отсутствует в DOM', () => {
    renderWithProviders(<MainLayout />, { route: '/game/abc-123' });
    expect(screen.queryByTestId('chat-widget-mock')).not.toBeInTheDocument();
  });
});
