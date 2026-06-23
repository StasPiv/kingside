import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../test/test-utils';
import { SettingsPage } from './SettingsPage';

/**
 * KS-2970 — поведенческий тест на toggle «Автопревращение в ферзя».
 * Проверяем что:
 *  - чекбокс есть на странице, по умолчанию unchecked;
 *  - клик переключает значение в localStorage (через BoardSettingsContext);
 *  - подсказка отрендерилась.
 *
 * Остальной функционал SettingsPage не трогаем — здесь только секция
 * настроек доски, KS-2970.
 */

vi.mock('../api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'tester', email: 't@e.st' },
  }),
}));

vi.mock('../hooks/useSounds', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useSounds')>(
    '../hooks/useSounds',
  );
  return {
    ...actual,
    useSounds: () => ({
      playSound: vi.fn(),
      muted: false,
      toggleMute: vi.fn(),
      theme: 'standard' as const,
      setTheme: vi.fn(),
    }),
    previewSound: vi.fn(),
  };
});

vi.mock('../hooks/useDrillSounds', () => ({
  useDrillSounds: () => ({
    drillMuted: false,
    toggleDrillMuted: vi.fn(),
  }),
}));

beforeEach(() => {
  // KS-4569: явный cleanup() перед каждым тестом. Auto-cleanup в
  // глобальном `afterEach` (см. src/test/setup.ts) обычно справляется,
  // но при срабатывании `useEffect` после unmount в react 19 +
  // happy-dom DOM иногда успевал «подцепить» новый рендер — и
  // следующий тест видел два инстанса SettingsPage в одном body
  // («Found multiple elements»).
  cleanup();
  localStorage.clear();
});

// KS-4565 / ADR-141 §4.3: после группировки страницы по вкладкам
// `auto-promote-queen` живёт во вкладке «Доска», а Maia ELO — во
// вкладке «Игра и анализ». Указываем нужный `?tab=` в `route` для
// renderWithProviders, иначе по умолчанию открывается `account`
// и testid не находится.

describe('SettingsPage / auto-promote queen toggle (KS-2970)', () => {
  it('чекбокс рендерится с подсказкой и по умолчанию выключен', () => {
    renderWithProviders(<SettingsPage />, { route: '/settings?tab=board' });
    const toggle = screen.getByTestId(
      'settings-auto-promote-queen-toggle',
    ) as HTMLInputElement;
    expect(toggle).toBeInTheDocument();
    expect(toggle.checked).toBe(false);
    // Лейбл и подсказка из i18n (en — locale в test-utils).
    expect(screen.getByText('Auto-promote to queen')).toBeInTheDocument();
    expect(
      screen.getByText(/A pawn reaching the last rank/i),
    ).toBeInTheDocument();
  });

  it('клик по чекбоксу включает настройку и пишет в localStorage', () => {
    renderWithProviders(<SettingsPage />, { route: '/settings?tab=board' });
    const toggle = screen.getByTestId(
      'settings-auto-promote-queen-toggle',
    ) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(localStorage.getItem('autoPromoteToQueen')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(localStorage.getItem('autoPromoteToQueen')).toBe('false');
  });

  it('значение из localStorage пред-заполняет чекбокс', () => {
    localStorage.setItem('autoPromoteToQueen', 'true');
    renderWithProviders(<SettingsPage />, { route: '/settings?tab=board' });
    const toggle = screen.getByTestId(
      'settings-auto-promote-queen-toggle',
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });
});

describe('SettingsPage / Maia level (KS-3600)', () => {
  it('рендерит селект с 14 опциями 1100..2400 и дефолт 1500', () => {
    renderWithProviders(<SettingsPage />, { route: '/settings?tab=game' });
    const select = screen.getByTestId(
      'settings-maia-elo-select',
    ) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.options).toHaveLength(14);
    expect(select.options[0].value).toBe('1100');
    expect(select.options[13].value).toBe('2400');
    expect(select.value).toBe('1500');
  });

  it('смена значения пишется в localStorage `analysis.maia.elo`', () => {
    renderWithProviders(<SettingsPage />, { route: '/settings?tab=game' });
    const select = screen.getByTestId(
      'settings-maia-elo-select',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1900' } });
    expect(select.value).toBe('1900');
    expect(localStorage.getItem('analysis.maia.elo')).toBe('1900');
  });

  it('значение из localStorage пред-заполняет селект (1700)', () => {
    localStorage.setItem('analysis.maia.elo', '1700');
    renderWithProviders(<SettingsPage />, { route: '/settings?tab=game' });
    const select = screen.getByTestId(
      'settings-maia-elo-select',
    ) as HTMLSelectElement;
    expect(select.value).toBe('1700');
  });
});
