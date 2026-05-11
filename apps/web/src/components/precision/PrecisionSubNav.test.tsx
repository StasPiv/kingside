/**
 * KS-2743 / ADR-057. Тесты `<PrecisionSubNav />`.
 *
 * Покрытие:
 *  - аутентифицированному показывает все 3 пункта;
 *  - гостю «Прогресс» и «История» скрыты, «Тренировка» остаётся;
 *  - активный пункт по `useLocation` (точное совпадение `/precision`,
 *    `/precision/stats`, `/precision/history`);
 *  - `/precision/attempts/:id` не подсвечивает ни один пункт;
 *  - ссылки ведут на верные пути;
 *  - i18n-ключи рендерятся (en).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionSubNav } from './PrecisionSubNav';

const authValue: { user: { id: string; username: string } | null } = {
  user: null,
};
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: authValue.user, loading: false }),
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe('<PrecisionSubNav>', () => {
  beforeEach(() => {
    authValue.user = { id: 'u1', username: 'tester' };
  });

  it('рендерит все 3 ссылки для аутентифицированного пользователя', () => {
    renderWithProviders(<PrecisionSubNav />, { route: '/precision' });
    const root = screen.getByTestId('precision-subnav');
    expect(root).toBeTruthy();
    expect(root.getAttribute('data-guest')).toBe('false');

    expect(screen.getByTestId('precision-subnav-training')).toBeTruthy();
    expect(screen.getByTestId('precision-subnav-progress')).toBeTruthy();
    expect(screen.getByTestId('precision-subnav-history')).toBeTruthy();
  });

  it('ссылки ведут на корректные пути', () => {
    renderWithProviders(<PrecisionSubNav />, { route: '/precision' });

    expect(
      screen.getByTestId('precision-subnav-training').getAttribute('href'),
    ).toBe('/precision');
    expect(
      screen.getByTestId('precision-subnav-progress').getAttribute('href'),
    ).toBe('/precision/stats');
    expect(
      screen.getByTestId('precision-subnav-history').getAttribute('href'),
    ).toBe('/precision/history');
  });

  it('активным помечает только пункт с точно совпадающим pathname (/precision)', () => {
    renderWithProviders(<PrecisionSubNav />, { route: '/precision' });

    expect(
      screen.getByTestId('precision-subnav-training').getAttribute('data-active'),
    ).toBe('true');
    expect(
      screen.getByTestId('precision-subnav-training').getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen.getByTestId('precision-subnav-progress').getAttribute('data-active'),
    ).toBe('false');
    expect(
      screen.getByTestId('precision-subnav-history').getAttribute('data-active'),
    ).toBe('false');
  });

  it('активным помечает /precision/stats при соответствующем pathname', () => {
    renderWithProviders(<PrecisionSubNav />, { route: '/precision/stats' });

    expect(
      screen.getByTestId('precision-subnav-progress').getAttribute('data-active'),
    ).toBe('true');
    expect(
      screen.getByTestId('precision-subnav-training').getAttribute('data-active'),
    ).toBe('false');
    expect(
      screen.getByTestId('precision-subnav-history').getAttribute('data-active'),
    ).toBe('false');
  });

  it('активным помечает /precision/history при соответствующем pathname', () => {
    renderWithProviders(<PrecisionSubNav />, { route: '/precision/history' });

    expect(
      screen.getByTestId('precision-subnav-history').getAttribute('data-active'),
    ).toBe('true');
    expect(
      screen.getByTestId('precision-subnav-training').getAttribute('data-active'),
    ).toBe('false');
    expect(
      screen.getByTestId('precision-subnav-progress').getAttribute('data-active'),
    ).toBe('false');
  });

  it('на /precision/attempts/:id ни один пункт не подсвечен (точное совпадение)', () => {
    renderWithProviders(<PrecisionSubNav />, {
      route: '/precision/attempts/abc-123',
    });

    expect(
      screen.getByTestId('precision-subnav-training').getAttribute('data-active'),
    ).toBe('false');
    expect(
      screen.getByTestId('precision-subnav-progress').getAttribute('data-active'),
    ).toBe('false');
    expect(
      screen.getByTestId('precision-subnav-history').getAttribute('data-active'),
    ).toBe('false');
  });

  it('гостю показывает только «Тренировка», «Прогресс» и «История» скрыты', () => {
    authValue.user = null;
    renderWithProviders(<PrecisionSubNav />, { route: '/precision' });

    const root = screen.getByTestId('precision-subnav');
    expect(root.getAttribute('data-guest')).toBe('true');

    expect(screen.getByTestId('precision-subnav-training')).toBeTruthy();
    expect(screen.queryByTestId('precision-subnav-progress')).toBeNull();
    expect(screen.queryByTestId('precision-subnav-history')).toBeNull();
  });

  it('рендерит i18n-тексты (en-locale из test-utils)', () => {
    renderWithProviders(<PrecisionSubNav />, { route: '/precision' });

    expect(
      screen.getByTestId('precision-subnav-training').textContent,
    ).toBe('Training');
    expect(
      screen.getByTestId('precision-subnav-progress').textContent,
    ).toBe('Progress');
    expect(
      screen.getByTestId('precision-subnav-history').textContent,
    ).toBe('History');
  });
});
