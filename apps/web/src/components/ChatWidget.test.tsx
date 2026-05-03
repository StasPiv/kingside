import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2228 — runtime feature-flag `assistantEnabled` для ChatWidget.
 *
 * Default `assistantEnabled=false` (KS-2222). Если флаг выключен,
 * `<ChatWidget>` возвращает `null` ДО любых других проверок (auth,
 * VITE_AI_CHAT_ENABLED) — иконка чата не появляется ни на одной
 * странице. Включение через PATCH /admin/feature-flags/assistantEnabled
 * показывает иконку (если есть auth и build-time флаг).
 *
 * Покрытие:
 *  - assistantEnabled=false → null (нет кнопки 💬).
 *  - assistantEnabled=true + user → кнопка 💬 рендерится.
 *  - assistantEnabled=true + no user → null (auth-проверка остаётся).
 */

const flagControls = { assistant: false };
const authControls: { user: { id: string; username: string } | null } = {
  user: { id: 'u1', username: 'tester' },
};

vi.mock('../context/FeatureFlagsContext', () => ({
  useFeatureFlag: (key: string) => {
    if (key === 'assistantEnabled') return flagControls.assistant;
    return false;
  },
  useFeatureFlags: () => ({
    flags: { assistantEnabled: flagControls.assistant },
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
    assistantEnabled: false,
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: authControls.user,
    loading: false,
    token: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

// ChatProvider не смонтирован в test-harness — мокаем сам useChat.
vi.mock('../context/ChatContext', () => ({
  useChat: () => ({
    open: false,
    setOpen: vi.fn(),
    messages: [],
    streaming: false,
    conversationId: null,
    usage: null,
    rateLimitEnd: null,
    sendMessage: vi.fn(),
    stopStreaming: vi.fn(),
    loadConversation: vi.fn(),
    newConversation: vi.fn(),
    fetchUsage: vi.fn(),
  }),
}));

vi.mock('../api', () => ({
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn() },
}));

import { ChatWidget } from './ChatWidget';

beforeEach(() => {
  flagControls.assistant = false;
  authControls.user = { id: 'u1', username: 'tester' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<ChatWidget> — KS-2228 assistantEnabled', () => {
  it('assistantEnabled=false (default) → ничего не рендерится', () => {
    flagControls.assistant = false;
    const { container } = renderWithProviders(<ChatWidget />);
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByTitle(/AI Assistant|ассистент/i),
    ).not.toBeInTheDocument();
  });

  it('assistantEnabled=true + есть user → кнопка чата (💬) рендерится', () => {
    flagControls.assistant = true;
    renderWithProviders(<ChatWidget />);
    const btn = screen.getByTitle(/AI Assistant|ассистент/i);
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent('💬');
  });

  it('assistantEnabled=true + НЕТ user → ничего не рендерится (auth-guard остался)', () => {
    flagControls.assistant = true;
    authControls.user = null;
    const { container } = renderWithProviders(<ChatWidget />);
    expect(container).toBeEmptyDOMElement();
  });

  it('assistantEnabled=false + есть user → ничего не рендерится (флаг важнее)', () => {
    flagControls.assistant = false;
    authControls.user = { id: 'u1', username: 'tester' };
    const { container } = renderWithProviders(<ChatWidget />);
    expect(container).toBeEmptyDOMElement();
  });
});
