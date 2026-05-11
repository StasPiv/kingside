/**
 * KS-2744 / ADR-057. Тесты `PrecisionStatsPage`.
 *
 * Покрытие:
 *  - Гостю показываем CTA-блок (login link), 3 содержательных блока скрыты.
 *  - Авторизованному рендерим: SubNav + 4 карточки + Trends + Breakdowns.
 *  - При totalAttempts=0 — карточки в empty-state placeholder.
 *  - Sub-nav сверху на месте, на /precision/stats активен пункт «Прогресс».
 *  - API-моки: /precision/stats/me, /precision/trends/me, /precision/breakdowns/me.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../test/test-utils';

const authValue: { user: { id: string; username: string } | null } = {
  user: { id: 'u1', username: 'tester' },
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authValue.user, loading: false }),
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Мокаем api.get — компоненты Trends / Breakdowns используют его
// напрямую (DI fetcher только в их собственных тестах). Здесь
// PrecisionStatsPage никаких props не пробрасывает, поэтому
// перехватываем единый api.get и роутим по URL.
const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
  },
}));

import { PrecisionStatsPage } from './PrecisionStatsPage';

beforeEach(() => {
  authValue.user = { id: 'u1', username: 'tester' };
  apiGet.mockReset();
});

function routeApi(handlers: Record<string, unknown | (() => unknown)>) {
  apiGet.mockImplementation((url: string) => {
    for (const prefix of Object.keys(handlers)) {
      if (url.startsWith(prefix)) {
        const h = handlers[prefix];
        const value = typeof h === 'function' ? (h as () => unknown)() : h;
        return Promise.resolve(value);
      }
    }
    return Promise.reject(new Error(`unexpected api.get url: ${url}`));
  });
}

describe('PrecisionStatsPage', () => {
  it('гостю показывает CTA login + скрывает блоки статистики', async () => {
    authValue.user = null;
    renderWithProviders(<PrecisionStatsPage />, { route: '/precision/stats' });

    const root = screen.getByTestId('precision-stats-page');
    expect(root.getAttribute('data-auth')).toBe('guest');
    expect(screen.getByTestId('precision-stats-guest-cta')).toBeTruthy();

    const ctaLink = screen.getByTestId('precision-stats-guest-cta-link');
    expect(ctaLink.getAttribute('href')).toBe('/login');

    // Контент-блоки не отрисованы.
    expect(screen.queryByTestId('precision-stats')).toBeNull();
    expect(screen.queryByTestId('precision-trends')).toBeNull();
    expect(screen.queryByTestId('precision-breakdowns')).toBeNull();

    // SubNav всё равно есть, но без пунктов «Прогресс»/«История».
    expect(screen.getByTestId('precision-subnav')).toBeTruthy();
    expect(screen.queryByTestId('precision-subnav-progress')).toBeNull();
    expect(screen.queryByTestId('precision-subnav-history')).toBeNull();
  });

  it('авторизованному рендерит SubNav + 4 карточки + Trends + Breakdowns', async () => {
    routeApi({
      '/precision/stats/me': {
        totalAttempts: 12,
        preservedCount: 8,
        avgAccuracyPercent: 78,
        avgWdlLeakPerMove: 0.05,
        avgHalfMovesUntilFirstMistake: 4.2,
      },
      '/precision/trends/me': {
        bucket: 'week',
        points: [
          {
            bucketStart: '2026-05-01T00:00:00Z',
            attempts: 5,
            preserved: 4,
            avgAccuracyPercent: 80,
            avgWdlLeakPerMove: 0.03,
          },
          {
            bucketStart: '2026-05-08T00:00:00Z',
            attempts: 7,
            preserved: 4,
            avgAccuracyPercent: 75,
            avgWdlLeakPerMove: 0.05,
          },
        ],
      },
      '/precision/breakdowns/me': {
        byPhase: [
          { phase: 'opening', attempts: 5, avgAccuracyPercent: 80 },
          { phase: 'middlegame', attempts: 4, avgAccuracyPercent: 70 },
          { phase: 'endgame', attempts: 3, avgAccuracyPercent: 60 },
        ],
        byTheme: [
          { theme: 'fork', attempts: 6, avgAccuracyPercent: 50 },
        ],
      },
    });

    renderWithProviders(<PrecisionStatsPage />, { route: '/precision/stats' });

    expect(
      screen.getByTestId('precision-stats-page').getAttribute('data-auth'),
    ).toBe('user');

    // SubNav: активный пункт — «Прогресс».
    expect(
      screen.getByTestId('precision-subnav-progress').getAttribute('data-active'),
    ).toBe('true');
    expect(
      screen.getByTestId('precision-subnav-training').getAttribute('data-active'),
    ).toBe('false');

    // Карточки выходят в ready.
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-stats').getAttribute('data-state'),
      ).toBe('ready');
    });
    expect(screen.getByTestId('precision-stats-accuracy')).toBeTruthy();
    expect(screen.getByTestId('precision-stats-preserved')).toBeTruthy();
    expect(screen.getByTestId('precision-stats-leak')).toBeTruthy();
    expect(screen.getByTestId('precision-stats-first-mistake')).toBeTruthy();

    // Trends ready.
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-trends').getAttribute('data-state'),
      ).toBe('ready');
    });

    // Breakdowns отрисован (data-state может быть ready/empty в зависимости
    // от внутренней логики компонента — проверяем сам факт рендера).
    await waitFor(() => {
      expect(screen.getByTestId('precision-breakdowns')).toBeTruthy();
    });

    // CTA гостя скрыт.
    expect(screen.queryByTestId('precision-stats-guest-cta')).toBeNull();
  });

  it('totalAttempts=0 → top-карточки в empty-state', async () => {
    routeApi({
      '/precision/stats/me': {
        totalAttempts: 0,
        preservedCount: 0,
        avgAccuracyPercent: null,
        avgWdlLeakPerMove: null,
        avgHalfMovesUntilFirstMistake: null,
      },
      '/precision/trends/me': { bucket: 'week', points: [] },
      '/precision/breakdowns/me': { byPhase: [], byTheme: [] },
    });

    renderWithProviders(<PrecisionStatsPage />, { route: '/precision/stats' });

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-stats').getAttribute('data-state'),
      ).toBe('empty');
    });
    expect(screen.getByTestId('precision-stats-placeholder')).toBeTruthy();
  });

  it('graceful fallback: /precision/stats/me → reject', async () => {
    routeApi({
      '/precision/stats/me': () => {
        throw new Error('404');
      },
      '/precision/trends/me': { bucket: 'week', points: [] },
      '/precision/breakdowns/me': { byPhase: [], byTheme: [] },
    });

    renderWithProviders(<PrecisionStatsPage />, { route: '/precision/stats' });

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-stats').getAttribute('data-state'),
      ).toBe('empty');
    });
  });
});
