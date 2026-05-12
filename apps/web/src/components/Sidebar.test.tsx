import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2800 (ADR-058 §4.1, §6.2 T4): Sidebar теперь содержит 5 групповых
 * контентных пунктов:
 *   1. ♟ Играть      → /play
 *   2. 🧠 Тренировка → /train  (customGate: видим всегда — Rush открыт)
 *   3. 🎓 Уроки      → /lessons (gated: lessonsEnabled)
 *   4. 📺 Трансляции → /broadcasts (gated: broadcastsEnabled)
 *   5. 🔬 Анализ     → /analyze (без gating)
 *
 * Подразделы (puzzles/drills/precision/workshop/archive/tournaments)
 * удалены с топ-уровня — доступ через лобби-страницы.
 *
 * Тесты на футер (Профиль/Друзья/Настройки/Feedback/Admin) — в KS-2801.
 */

const flagControls = {
  lessons: true,
  puzzles: false,
  broadcasts: true,
  tournaments: true,
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

vi.mock('./FeedbackModal', () => ({
  FeedbackModal: () => <div data-testid="feedback-modal-mock" />,
}));

const adminControls = { isAdmin: false };
vi.mock('../hooks/useAdminStatus', () => ({
  useAdminStatus: () => ({ isAdmin: adminControls.isAdmin, loading: false }),
}));

const authControls: { user: { id: string; username: string } | null } = {
  user: { id: 'u1', username: 'tester' },
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authControls.user, loading: false }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

describe('<Sidebar> KS-2800 — 5 group nav-items', () => {
  it('дефолтные флаги: видны 5 группового пункта (play, train, lessons, broadcasts, analyze)', () => {
    renderWithProviders(<Sidebar />);
    expect(screen.getByTitle(/^play$|^играть$/i).getAttribute('href')).toBe('/play');
    expect(screen.getByTitle(/^train$|^тренировка$/i).getAttribute('href')).toBe('/train');
    expect(screen.getByTitle(/^lessons$|^уроки$/i).getAttribute('href')).toBe('/lessons');
    expect(screen.getByTitle(/^tv$|^трансляции$/i).getAttribute('href')).toBe('/broadcasts');
    expect(screen.getByTitle(/^analyze$|^анализ$/i).getAttribute('href')).toBe('/analyze');
  });

  it('старые подразделы (puzzles/drills/precision/workshop/archive/tournaments) скрыты с топ-уровня', () => {
    flagControls.puzzles = true;
    flagControls.drills = true;
    renderWithProviders(<Sidebar />);
    // Прямых ссылок на под-разделы нет: они доступны через /train и /analyze.
    expect(screen.queryByTitle(/^puzzles$|^задачи$/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/puzzle rush/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^drills$|^тренажёры$/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/тренировка точности|^precision$/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^workshop$|^мастерская$/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^archive$|^архив$/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^tournaments$|^турниры$/i)).not.toBeInTheDocument();
  });

  it('lessonsEnabled=false → пункт «Уроки» скрыт, остальные 4 на месте', () => {
    flagControls.lessons = false;
    renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/^lessons$|^уроки$/i)).not.toBeInTheDocument();
    expect(screen.getByTitle(/^play$|^играть$/i)).toBeInTheDocument();
    expect(screen.getByTitle(/^train$|^тренировка$/i)).toBeInTheDocument();
    expect(screen.getByTitle(/^tv$|^трансляции$/i)).toBeInTheDocument();
    expect(screen.getByTitle(/^analyze$|^анализ$/i)).toBeInTheDocument();
  });

  it('broadcastsEnabled=false → пункт «Трансляции» скрыт', () => {
    flagControls.broadcasts = false;
    renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/^tv$|^трансляции$/i)).not.toBeInTheDocument();
    expect(screen.getByTitle(/^train$|^тренировка$/i)).toBeInTheDocument();
  });

  it('пункт «Тренировка» виден всегда (Puzzle Rush открыт) — даже при puzzlesEnabled=false && drillsEnabled=false', () => {
    flagControls.puzzles = false;
    flagControls.drills = false;
    renderWithProviders(<Sidebar />);
    expect(screen.getByTitle(/^train$|^тренировка$/i)).toBeInTheDocument();
  });

  it('пункт «Анализ» виден всегда (без gating)', () => {
    renderWithProviders(<Sidebar />);
    expect(screen.getByTitle(/^analyze$|^анализ$/i)).toBeInTheDocument();
  });

  it('KS-2252: иконка кнопки обратной связи — 📝 (не 💬)', () => {
    renderWithProviders(<Sidebar />);
    const btn = screen.getByTestId('sidebar-feedback-btn');
    expect(btn).toHaveTextContent('📝');
    expect(btn).not.toHaveTextContent('💬');
  });

  it('KS-2109: пункт «Админка» виден только админам', () => {
    adminControls.isAdmin = false;
    const { unmount } = renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/^admin$|^админка$/i)).not.toBeInTheDocument();
    unmount();

    adminControls.isAdmin = true;
    renderWithProviders(<Sidebar />);
    const adminLink = screen.getByTitle(/^admin$|^админка$/i);
    expect(adminLink.getAttribute('href')).toBe('/admin/feature-flags');
  });
});

/**
 * KS-2803 (T6, плановый отдельный тикет): подсветка групповых пунктов
 * по подразделам. Эти тесты живут здесь — match-список уже задан в
 * NAV_ITEMS (KS-2800), они отрабатывают сразу.
 */
describe('<Sidebar> KS-2800/KS-2803 — active highlight для group-пунктов', () => {
  it('на /puzzles подсвечен «Тренировка» (group match: /train, /puzzles, /puzzle, /puzzle-rush, /drills, /precision)', () => {
    flagControls.puzzles = true;
    renderWithProviders(<Sidebar />, { route: '/puzzles' });
    const train = screen.getByTitle(/^train$|^тренировка$/i);
    expect(train.className).toContain('sidebar-item--active');
  });

  it('на /puzzle-rush подсвечен «Тренировка»', () => {
    renderWithProviders(<Sidebar />, { route: '/puzzle-rush' });
    const train = screen.getByTitle(/^train$|^тренировка$/i);
    expect(train.className).toContain('sidebar-item--active');
  });

  it('на /precision/stats подсвечен «Тренировка»', () => {
    flagControls.puzzles = true;
    renderWithProviders(<Sidebar />, { route: '/precision/stats' });
    const train = screen.getByTitle(/^train$|^тренировка$/i);
    expect(train.className).toContain('sidebar-item--active');
  });

  it('на /workshop подсвечен «Анализ»', () => {
    renderWithProviders(<Sidebar />, { route: '/workshop' });
    const analyze = screen.getByTitle(/^analyze$|^анализ$/i);
    expect(analyze.className).toContain('sidebar-item--active');
  });

  it('на /archive/games подсвечен «Анализ»', () => {
    renderWithProviders(<Sidebar />, { route: '/archive/games' });
    const analyze = screen.getByTitle(/^analyze$|^анализ$/i);
    expect(analyze.className).toContain('sidebar-item--active');
  });

  it('на /analysis/<uuid> подсвечен «Анализ» (legacy URL)', () => {
    renderWithProviders(<Sidebar />, { route: '/analysis/abc' });
    const analyze = screen.getByTitle(/^analyze$|^анализ$/i);
    expect(analyze.className).toContain('sidebar-item--active');
  });
});
