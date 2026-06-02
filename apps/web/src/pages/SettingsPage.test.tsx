import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
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
  localStorage.clear();
});

describe('SettingsPage / auto-promote queen toggle (KS-2970)', () => {
  it('чекбокс рендерится с подсказкой и по умолчанию выключен', () => {
    renderWithProviders(<SettingsPage />);
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
    renderWithProviders(<SettingsPage />);
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
    renderWithProviders(<SettingsPage />);
    const toggle = screen.getByTestId(
      'settings-auto-promote-queen-toggle',
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });
});

describe('SettingsPage / Maia level (KS-3600)', () => {
  it('рендерит селект с 14 опциями 1100..2400 и дефолт 1500', () => {
    renderWithProviders(<SettingsPage />);
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
    renderWithProviders(<SettingsPage />);
    const select = screen.getByTestId(
      'settings-maia-elo-select',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1900' } });
    expect(select.value).toBe('1900');
    expect(localStorage.getItem('analysis.maia.elo')).toBe('1900');
  });

  it('значение из localStorage пред-заполняет селект (1700)', () => {
    localStorage.setItem('analysis.maia.elo', '1700');
    renderWithProviders(<SettingsPage />);
    const select = screen.getByTestId(
      'settings-maia-elo-select',
    ) as HTMLSelectElement;
    expect(select.value).toBe('1700');
  });
});
