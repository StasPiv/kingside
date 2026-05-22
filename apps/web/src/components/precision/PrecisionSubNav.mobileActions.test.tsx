import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionSubNav } from './PrecisionSubNav';

/**
 * KS-3244 (ADR-076 §7 F2): тесты mobile-actions (ⓘ + ⋮) в PrecisionSubNav.
 *
 * Старые тесты PrecisionSubNav.test.tsx покрывают tabs/auth. Тут — только
 * новые контролы: popover для описания и dropdown для action'ов.
 */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'u' },
    loading: false,
    token: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

function renderNav(opts: { onGenerate?: () => void } = {}) {
  return renderWithProviders(
    <PrecisionSubNav onGenerateClick={opts.onGenerate} />,
    { route: '/precision' },
  );
}

describe('<PrecisionSubNav> mobile actions (KS-3244)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('ⓘ-кнопка всегда видна, ⋮ — только при наличии onGenerateClick', () => {
    renderNav();
    expect(screen.queryByTestId('precision-subnav-info-btn')).toBeTruthy();
    expect(screen.queryByTestId('precision-subnav-menu-btn')).toBeNull();

    document.body.innerHTML = '';
    renderNav({ onGenerate: vi.fn() });
    expect(screen.queryByTestId('precision-subnav-info-btn')).toBeTruthy();
    expect(screen.queryByTestId('precision-subnav-menu-btn')).toBeTruthy();
  });

  it('Клик ⓘ → открывается popover с описанием', () => {
    renderNav();
    expect(
      screen.queryByTestId('precision-subnav-info-popover'),
    ).toBeNull();
    fireEvent.click(screen.getByTestId('precision-subnav-info-btn'));
    const popover = screen.getByTestId('precision-subnav-info-popover');
    expect(popover.textContent?.length).toBeGreaterThan(20);
  });

  it('Клик ⋮ → dropdown с «← Все пазлы» + «Генерация»; клик на «Генерация» вызывает callback', () => {
    const onGenerate = vi.fn();
    renderNav({ onGenerate });
    fireEvent.click(screen.getByTestId('precision-subnav-menu-btn'));
    expect(screen.queryByTestId('precision-subnav-menu-back')).toBeTruthy();
    fireEvent.click(screen.getByTestId('precision-subnav-menu-generate'));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it('Esc закрывает открытые popover и menu', () => {
    renderNav({ onGenerate: vi.fn() });
    fireEvent.click(screen.getByTestId('precision-subnav-info-btn'));
    expect(
      screen.queryByTestId('precision-subnav-info-popover'),
    ).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      screen.queryByTestId('precision-subnav-info-popover'),
    ).toBeNull();
  });

  it('Открытие ⋮ закрывает ⓘ-popover (взаимоисключение)', () => {
    renderNav({ onGenerate: vi.fn() });
    fireEvent.click(screen.getByTestId('precision-subnav-info-btn'));
    expect(
      screen.queryByTestId('precision-subnav-info-popover'),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId('precision-subnav-menu-btn'));
    expect(
      screen.queryByTestId('precision-subnav-info-popover'),
    ).toBeNull();
    expect(screen.queryByTestId('precision-subnav-menu')).toBeTruthy();
  });
});
