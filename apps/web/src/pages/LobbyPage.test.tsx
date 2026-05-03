import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2218 — фильтрация тизеров «Задачи»/«Трансляции»/«Турниры» в лобби
 * по runtime feature-flags (`puzzlesEnabled`/`broadcastsEnabled`/
 * `tournamentsEnabled`).
 *
 * Тизер `tournaments` в лобби физически отсутствует (KS-2218 §дополнение
 * требует только убедиться, что нет CTA на `/tournaments`); проверяем это
 * `queryByText`-ом по подстроке `/tournaments` и поиском по data-testid.
 */

const flagControls = {
  // KS-2218: дефолты повторяют backend whitelist (KS-2217).
  puzzles: false,
  broadcasts: true,
  tournaments: true,
  lessons: true,
};

vi.mock('../context/FeatureFlagsContext', () => ({
  useFeatureFlag: (key: string) => {
    if (key === 'puzzlesEnabled') return flagControls.puzzles;
    if (key === 'broadcastsEnabled') return flagControls.broadcasts;
    if (key === 'tournamentsEnabled') return flagControls.tournaments;
    if (key === 'lessonsEnabled') return flagControls.lessons;
    return false;
  },
  useFeatureFlags: () => ({
    flags: {
      puzzlesEnabled: flagControls.puzzles,
      broadcastsEnabled: flagControls.broadcasts,
      tournamentsEnabled: flagControls.tournaments,
      lessonsEnabled: flagControls.lessons,
    },
    loading: false,
    error: null,
    refresh: async () => {},
  }),
  FeatureFlagsProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DEFAULT_FLAGS: {
    puzzlesEnabled: false,
    broadcastsEnabled: true,
    tournamentsEnabled: true,
    lessonsEnabled: true,
  },
}));

// Лобби читает auth-контекст; для guest-режима достаточно `user: null`.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    login: async () => {},
    logout: async () => {},
    setUser: () => {},
  }),
}));

// Хуки, дёргающие реальные API-/WS-вызовы, заменяем заглушками —
// нас интересует только рендер сетки тизеров.
vi.mock('../hooks/useTimeControl', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useTimeControl')>(
    '../hooks/useTimeControl',
  );
  return {
    ...actual,
    useTimeControl: () => ({
      selectedMinutes: 5,
      selectedIncrement: 0,
      showCustomForm: false,
      setShowCustomForm: () => {},
      customMinutes: 5,
      setCustomMinutes: () => {},
      customIncrement: 0,
      setCustomIncrement: () => {},
      savedControls: [],
      activeTab: 'blitz' as const,
      setActiveTab: () => {},
      handleSelectPreset: () => {},
      handleSaveCustom: () => {},
      handleUseCustom: () => {},
      handleDeleteSaved: () => {},
      handleSelectSaved: () => {},
      isSelected: () => false,
      filteredPresets: [],
    }),
  };
});

vi.mock('../hooks/useMatchmaking', () => ({
  useMatchmaking: () => ({
    searching: false,
    ratingFilterMode: 'none' as const,
    setRatingFilterMode: () => {},
    ratingMin: 0,
    setRatingMin: () => {},
    ratingMax: 4000,
    setRatingMax: () => {},
    ratingMinus: 200,
    setRatingMinus: () => {},
    ratingPlus: 200,
    setRatingPlus: () => {},
    handleSearch: () => {},
    noOpponents: false,
    retryAfterNoOpponents: () => {},
    dismissNoOpponents: () => {},
    serverBusy: false,
  }),
}));

vi.mock('../hooks/useBotGame', () => ({
  useBotGame: () => ({
    botLevel: 1,
    setBotLevel: () => {},
    botColor: 'white' as const,
    setBotColor: () => {},
    botTC: 'blitz' as const,
    setBotTC: () => {},
    startingBot: false,
    showBotTCModal: false,
    setShowBotTCModal: () => {},
    handlePlayBot: () => {},
    botError: null,
    setBotError: () => {},
  }),
}));

vi.mock('../api', () => ({
  api: {
    get: vi.fn(async () => ({ best3: 0, best5: 0, totalSessions: 0 })),
    post: vi.fn(async () => ({})),
  },
}));

vi.mock('../components/HelpButton', () => ({
  HelpButton: () => null,
}));

vi.mock('../components/ServerBusyBanner', () => ({
  ServerBusyBanner: () => null,
}));

vi.mock('../components/NoOpponentsBlock', () => ({
  NoOpponentsBlock: () => null,
}));

import { LobbyPage } from './LobbyPage';

beforeEach(() => {
  flagControls.puzzles = false;
  flagControls.broadcasts = true;
  flagControls.tournaments = true;
  flagControls.lessons = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<LobbyPage> feature-flags', () => {
  it('puzzlesEnabled=false (default) → карточка «Задачи» отсутствует', () => {
    flagControls.puzzles = false;
    renderWithProviders(<LobbyPage />);
    expect(screen.queryByTestId('lobby-teaser-puzzles')).not.toBeInTheDocument();
  });

  it('puzzlesEnabled=true → карточка «Задачи» появляется', () => {
    flagControls.puzzles = true;
    renderWithProviders(<LobbyPage />);
    expect(screen.getByTestId('lobby-teaser-puzzles')).toBeInTheDocument();
  });

  it('broadcastsEnabled=false → карточка «Трансляции» отсутствует', () => {
    flagControls.broadcasts = false;
    renderWithProviders(<LobbyPage />);
    expect(
      screen.queryByTestId('lobby-teaser-broadcasts'),
    ).not.toBeInTheDocument();
  });

  it('broadcastsEnabled=true → карточка «Трансляции» видна', () => {
    flagControls.broadcasts = true;
    renderWithProviders(<LobbyPage />);
    expect(screen.getByTestId('lobby-teaser-broadcasts')).toBeInTheDocument();
  });

  it('tournamentsEnabled=false → нет CTA-ссылок на /tournaments в лобби', () => {
    // В лобби KS-2218 не предусматривает отдельного teaser'а для турниров,
    // но scenario координатора прямо запрещает наличие любых ссылок на
    // `/tournaments` при выкл. флаге. Проверяем, что таких href нет.
    flagControls.tournaments = false;
    const { container } = renderWithProviders(<LobbyPage />);
    const tournamentLinks = container.querySelectorAll(
      'a[href*="/tournaments"], a[href^="/arena"], a[href^="/t/"]',
    );
    expect(tournamentLinks.length).toBe(0);
  });

  it('все три флага off → одновременно нет «Задачи», «Трансляции» и ссылок на турниры', () => {
    flagControls.puzzles = false;
    flagControls.broadcasts = false;
    flagControls.tournaments = false;
    const { container } = renderWithProviders(<LobbyPage />);
    expect(screen.queryByTestId('lobby-teaser-puzzles')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('lobby-teaser-broadcasts'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelectorAll('a[href*="/tournaments"]').length,
    ).toBe(0);
    // Соседние тизеры (без флага) остаются на месте.
    expect(screen.getByTestId('lobby-teaser-human')).toBeInTheDocument();
    expect(screen.getByTestId('lobby-teaser-bot')).toBeInTheDocument();
    expect(screen.getByTestId('lobby-teaser-rush')).toBeInTheDocument();
  });

  it('все три флага on → карточки «Задачи»/«Трансляции» возвращаются', () => {
    flagControls.puzzles = true;
    flagControls.broadcasts = true;
    flagControls.tournaments = true;
    renderWithProviders(<LobbyPage />);
    expect(screen.getByTestId('lobby-teaser-puzzles')).toBeInTheDocument();
    expect(screen.getByTestId('lobby-teaser-broadcasts')).toBeInTheDocument();
  });
});
