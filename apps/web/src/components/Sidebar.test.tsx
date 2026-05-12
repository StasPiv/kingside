import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';

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

// KS-2846: для mobile-кейсов submenu Sidebar читает useIsMobile.
// По умолчанию false (desktop), переключаем в тестах под mobile.
const mobileState = { isMobile: false };
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => mobileState.isMobile,
}));

import { Sidebar } from './Sidebar';

beforeEach(() => {
  flagControls.lessons = true;
  // KS-2811: дефолт для тестов — `puzzlesEnabled=true`, чтобы группа
  // «Тренировка» отображалась (customGate теперь `puzzles || drills`).
  flagControls.puzzles = true;
  flagControls.broadcasts = true;
  flagControls.tournaments = true;
  flagControls.drills = false;
  adminControls.isAdmin = false;
  mobileState.isMobile = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<Sidebar> KS-2800 — 5 group nav-items', () => {
  it('дефолтные флаги: видны 5 группового пункта (play, train, lessons, broadcasts, analyze)', () => {
    renderWithProviders(<Sidebar />);
    // KS-2848: Play теперь тоже submenu-parent <button> (children:
    // Play + Tournaments). Train и Analyze также submenu (KS-2840).
    // jsdom (без touch) → isMobile=false → submenu активен.
    expect(screen.getByTestId('sidebar-submenu-parent-play')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-submenu-parent-train')).toBeInTheDocument();
    expect(screen.getByTitle(/^lessons$|^уроки$/i).getAttribute('href')).toBe('/lessons');
    expect(screen.getByTitle(/^tv$|^трансляции$/i).getAttribute('href')).toBe('/broadcasts');
    expect(screen.getByTestId('sidebar-submenu-parent-analyze')).toBeInTheDocument();
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

  it('KS-2811: «Тренировка» скрыта если puzzlesEnabled=false && drillsEnabled=false', () => {
    flagControls.puzzles = false;
    flagControls.drills = false;
    renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/^train$|^тренировка$/i)).not.toBeInTheDocument();
  });

  it('KS-2811: «Тренировка» видна если хотя бы один из puzzlesEnabled/drillsEnabled = true', () => {
    flagControls.puzzles = false;
    flagControls.drills = true;
    const { unmount } = renderWithProviders(<Sidebar />);
    expect(screen.getByTitle(/^train$|^тренировка$/i)).toBeInTheDocument();
    unmount();

    flagControls.puzzles = true;
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
 * KS-2801 (ADR-058 §4.1, §9.3, §6.2 T5): футер sidebar'а — Профиль,
 * Друзья, Настройки, Feedback (модалка), Admin. «Возможности»
 * (/features) убраны из футера.
 */
describe('<Sidebar> KS-2801 — footer', () => {
  it('авторизованный: видны Профиль, Друзья, Настройки, Feedback', () => {
    authControls.user = { id: 'u1', username: 'tester' };
    renderWithProviders(<Sidebar />);
    const footer = screen.getByTestId('sidebar-footer');
    expect(footer).toBeInTheDocument();
    expect(screen.getByTitle(/^profile$|^профиль$/i).getAttribute('href')).toBe('/profile');
    expect(screen.getByTitle(/^friends$|^друзья$/i).getAttribute('href')).toBe('/friends');
    expect(screen.getByTitle(/^settings$|^настройки$/i).getAttribute('href')).toBe('/settings');
    expect(screen.getByTestId('sidebar-feedback-btn')).toBeInTheDocument();
  });

  it('гость: Профиль / Друзья / Настройки скрыты (authOnly), Feedback виден', () => {
    authControls.user = null;
    renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/^profile$|^профиль$/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^friends$|^друзья$/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^settings$|^настройки$/i)).not.toBeInTheDocument();
    // Feedback-кнопка не authOnly — модалка работает и для гостей.
    expect(screen.getByTestId('sidebar-feedback-btn')).toBeInTheDocument();
    // Восстановим, чтобы не ломать следующие тесты.
    authControls.user = { id: 'u1', username: 'tester' };
  });

  it('«Возможности» (/features) убрано из футера', () => {
    renderWithProviders(<Sidebar />);
    expect(screen.queryByTitle(/^features$|^возможности$/i)).not.toBeInTheDocument();
  });

  it('пункт «Feedback» как страница (/feedback) — убран; остаётся только кнопка-модалка', () => {
    renderWithProviders(<Sidebar />);
    // Ссылки на /feedback нет — только кнопка с data-testid.
    const links = Array.from(document.querySelectorAll('a[href="/feedback"]'));
    expect(links).toHaveLength(0);
    expect(screen.getByTestId('sidebar-feedback-btn')).toBeInTheDocument();
  });

  it('«Админка» виден только админам и живёт в футере', () => {
    adminControls.isAdmin = true;
    renderWithProviders(<Sidebar />);
    const footer = screen.getByTestId('sidebar-footer');
    const admin = screen.getByTitle(/^admin$|^админка$/i);
    expect(footer.contains(admin)).toBe(true);
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

  it('KS-2803: на /tournaments подсвечен «Играть» (Турниры → группа Play)', () => {
    renderWithProviders(<Sidebar />, { route: '/tournaments' });
    const play = screen.getByTitle(/^play$|^играть$/i);
    expect(play.className).toContain('sidebar-item--active');
  });

  it('KS-2803: на /tournaments/abc подсвечен «Играть» (вложенный путь)', () => {
    renderWithProviders(<Sidebar />, { route: '/tournaments/abc' });
    const play = screen.getByTitle(/^play$|^играть$/i);
    expect(play.className).toContain('sidebar-item--active');
  });

  it('KS-2803: на /lessons/some-slug подсвечен «Уроки»', () => {
    renderWithProviders(<Sidebar />, { route: '/lessons/intro' });
    const lessons = screen.getByTitle(/^lessons$|^уроки$/i);
    expect(lessons.className).toContain('sidebar-item--active');
  });

  it('KS-2803: на /broadcasts/tid/rid подсвечен «Трансляции»', () => {
    renderWithProviders(<Sidebar />, { route: '/broadcasts/tid/rid' });
    const tv = screen.getByTitle(/^tv$|^трансляции$/i);
    expect(tv.className).toContain('sidebar-item--active');
  });

  it('KS-2803 (KS-2790 regression): ровно один топ-пункт активен на любом URL подгруппы', () => {
    flagControls.puzzles = true;
    renderWithProviders(<Sidebar />, { route: '/puzzle-rush' });
    // /puzzle-rush — это группа Train. Train теперь submenu-button, не Link.
    expect(
      screen.getByTestId('sidebar-submenu-parent-train').className,
    ).toContain('sidebar-item--active');
    expect(
      screen.getByTestId('sidebar-submenu-parent-analyze').className,
    ).not.toContain('sidebar-item--active');
    expect(
      screen.getByTitle(/^play$|^играть$/i).className,
    ).not.toContain('sidebar-item--active');
  });
});

/**
 * KS-2842 (ADR-058 §11.3): двойная подсветка — группа + активный
 * подпункт в открытом поповере. Используем строгий path-segment matcher
 * (фикс KS-2790): `/puzzle-rush` НЕ матчится в подпункт «Задачи»
 * (match=['/puzzles','/puzzle']), хоть `/puzzle-rush` и начинается с
 * `/puzzle`.
 */
describe('<Sidebar> KS-2842 — двойная подсветка group + подпункт', () => {
  beforeEach(() => {
    flagControls.puzzles = true;
    flagControls.drills = true;
  });

  it('на /puzzles: group Train + подпункт puzzles активны (после открытия поповера)', () => {
    renderWithProviders(<Sidebar />, { route: '/puzzles' });
    // Группа активна сразу (закрытое состояние).
    expect(
      screen.getByTestId('sidebar-submenu-parent-train').className,
    ).toContain('sidebar-item--active');
    // Откроем поповер кликом.
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-train'));
    expect(
      screen.getByTestId('sidebar-submenu-item-puzzles').className,
    ).toContain('sidebar-submenu__item--active');
    // Остальные подпункты НЕ активны.
    expect(
      screen.getByTestId('sidebar-submenu-item-puzzle-rush').className,
    ).not.toContain('sidebar-submenu__item--active');
  });

  it('на /puzzle-rush: подпункт puzzle-rush активен, puzzles НЕ активен (строгий path-segment)', () => {
    renderWithProviders(<Sidebar />, { route: '/puzzle-rush' });
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-train'));
    expect(
      screen.getByTestId('sidebar-submenu-item-puzzle-rush').className,
    ).toContain('sidebar-submenu__item--active');
    // `/puzzle-rush` не должен совпасть с `/puzzle` — это была регрессия
    // KS-2790. Подпункт «Задачи» (match=['/puzzles','/puzzle']) тут не active.
    expect(
      screen.getByTestId('sidebar-submenu-item-puzzles').className,
    ).not.toContain('sidebar-submenu__item--active');
  });

  it('на /precision/stats: подпункт precision активен (вложенный путь)', () => {
    renderWithProviders(<Sidebar />, { route: '/precision/stats' });
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-train'));
    expect(
      screen.getByTestId('sidebar-submenu-item-precision').className,
    ).toContain('sidebar-submenu__item--active');
  });

  it('на /workshop: group Analyze + подпункт workshop активны', () => {
    renderWithProviders(<Sidebar />, { route: '/workshop' });
    expect(
      screen.getByTestId('sidebar-submenu-parent-analyze').className,
    ).toContain('sidebar-item--active');
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-analyze'));
    expect(
      screen.getByTestId('sidebar-submenu-item-workshop').className,
    ).toContain('sidebar-submenu__item--active');
    expect(
      screen.getByTestId('sidebar-submenu-item-archive').className,
    ).not.toContain('sidebar-submenu__item--active');
  });

  it('на /archive/games: подпункт archive активен (вложенный путь)', () => {
    renderWithProviders(<Sidebar />, { route: '/archive/games' });
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-analyze'));
    expect(
      screen.getByTestId('sidebar-submenu-item-archive').className,
    ).toContain('sidebar-submenu__item--active');
  });

  it('на /drills: подпункт drills активен; rush НЕ активен', () => {
    renderWithProviders(<Sidebar />, { route: '/drills' });
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-train'));
    expect(
      screen.getByTestId('sidebar-submenu-item-drills').className,
    ).toContain('sidebar-submenu__item--active');
    expect(
      screen.getByTestId('sidebar-submenu-item-puzzle-rush').className,
    ).not.toContain('sidebar-submenu__item--active');
  });

  it('на /train (само лобби): group активен, но ни один подпункт не active (после открытия)', () => {
    renderWithProviders(<Sidebar />, { route: '/train' });
    expect(
      screen.getByTestId('sidebar-submenu-parent-train').className,
    ).toContain('sidebar-item--active');
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-train'));
    expect(
      screen.getByTestId('sidebar-submenu-item-puzzles').className,
    ).not.toContain('sidebar-submenu__item--active');
    expect(
      screen.getByTestId('sidebar-submenu-item-drills').className,
    ).not.toContain('sidebar-submenu__item--active');
  });
});

/**
 * KS-2846 / KS-2840: на mobile (useIsMobile=true) submenu не активен.
 * Train/Analyze рендерятся как обычные `<Link>` на лобби-страницы.
 */
describe('<Sidebar> KS-2846 — mobile: submenu выключен, обычные Link', () => {
  beforeEach(() => {
    mobileState.isMobile = true;
    flagControls.puzzles = true;
    flagControls.drills = true;
  });

  it('Train на mobile — обычная <Link> на /train, без submenu-popover', () => {
    renderWithProviders(<Sidebar />, { route: '/play' });
    // Submenu-parent НЕ рендерится; вместо него Link с title и href.
    expect(
      screen.queryByTestId('sidebar-submenu-parent-train'),
    ).not.toBeInTheDocument();
    const trainLink = screen.getByTitle(/^train$|^тренировка$/i);
    expect(trainLink.tagName).toBe('A');
    expect(trainLink.getAttribute('href')).toBe('/train');
  });

  it('Analyze на mobile — обычная <Link> на /analyze', () => {
    renderWithProviders(<Sidebar />, { route: '/play' });
    expect(
      screen.queryByTestId('sidebar-submenu-parent-analyze'),
    ).not.toBeInTheDocument();
    const analyzeLink = screen.getByTitle(/^analyze$|^анализ$/i);
    expect(analyzeLink.tagName).toBe('A');
    expect(analyzeLink.getAttribute('href')).toBe('/analyze');
  });

  it('на mobile подсветка group на /puzzles работает (через match)', () => {
    renderWithProviders(<Sidebar />, { route: '/puzzles' });
    const trainLink = screen.getByTitle(/^train$|^тренировка$/i);
    expect(trainLink.className).toContain('sidebar-item--active');
  });
});

/**
 * KS-2848 (ADR-058 §11.1 follow-up): «Играть» теперь submenu с
 * подпунктами «Играть» (/play) и «Турниры» (/tournaments). Mobile —
 * обычный Link на /play.
 */
describe('<Sidebar> KS-2848 — Play submenu с Турнирами', () => {
  beforeEach(() => {
    mobileState.isMobile = false;
    flagControls.tournaments = true;
  });

  it('desktop: Play теперь submenu-parent <button>', () => {
    renderWithProviders(<Sidebar />, { route: '/' });
    const parent = screen.getByTestId('sidebar-submenu-parent-play');
    expect(parent.tagName).toBe('BUTTON');
    expect(parent.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('desktop: click parent → поповер с подпунктами Play + Tournaments', () => {
    renderWithProviders(<Sidebar />, { route: '/' });
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-play'));
    expect(screen.getByTestId('sidebar-submenu-popover-play')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-submenu-item-play')).toBeInTheDocument();
    expect(
      screen.getByTestId('sidebar-submenu-item-tournaments'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('sidebar-submenu-item-play').getAttribute('href'),
    ).toBe('/play');
    expect(
      screen.getByTestId('sidebar-submenu-item-tournaments').getAttribute('href'),
    ).toBe('/tournaments');
  });

  it('desktop: tournamentsEnabled=false → подпункт «Турниры» скрыт, остаётся Play', () => {
    flagControls.tournaments = false;
    renderWithProviders(<Sidebar />, { route: '/' });
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-play'));
    expect(screen.getByTestId('sidebar-submenu-item-play')).toBeInTheDocument();
    expect(
      screen.queryByTestId('sidebar-submenu-item-tournaments'),
    ).not.toBeInTheDocument();
  });

  it('desktop: на /tournaments group Play + подпункт Tournaments active', () => {
    renderWithProviders(<Sidebar />, { route: '/tournaments' });
    expect(
      screen.getByTestId('sidebar-submenu-parent-play').className,
    ).toContain('sidebar-item--active');
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-play'));
    expect(
      screen.getByTestId('sidebar-submenu-item-tournaments').className,
    ).toContain('sidebar-submenu__item--active');
    expect(
      screen.getByTestId('sidebar-submenu-item-play').className,
    ).not.toContain('sidebar-submenu__item--active');
  });

  it('desktop: на /play group + подпункт Play active', () => {
    renderWithProviders(<Sidebar />, { route: '/play' });
    expect(
      screen.getByTestId('sidebar-submenu-parent-play').className,
    ).toContain('sidebar-item--active');
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-play'));
    expect(
      screen.getByTestId('sidebar-submenu-item-play').className,
    ).toContain('sidebar-submenu__item--active');
    expect(
      screen.getByTestId('sidebar-submenu-item-tournaments').className,
    ).not.toContain('sidebar-submenu__item--active');
  });

  it('mobile: Play — обычный <Link> на /play, submenu не активен', () => {
    mobileState.isMobile = true;
    renderWithProviders(<Sidebar />, { route: '/' });
    expect(
      screen.queryByTestId('sidebar-submenu-parent-play'),
    ).not.toBeInTheDocument();
    const playLink = screen.getByTitle(/^play$|^играть$/i);
    expect(playLink.tagName).toBe('A');
    expect(playLink.getAttribute('href')).toBe('/play');
  });
});
