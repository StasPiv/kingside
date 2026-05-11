/**
 * KS-2745 / ADR-057. Тесты `PrecisionHistoryPage`.
 *
 * Покрытие:
 *  - Гостю показываем CTA login + список скрыт + start-CTA скрыт.
 *  - Авторизованному рендерим SubNav (active=«История») + список +
 *    header-CTA «Начать тренировку».
 *  - Фильтры списка работают (Все/Удержано/Упущено).
 *  - Пагинация: «Загрузить ещё» делает повторный запрос с offset.
 *  - Empty-state списка показывается при 0 попыток (PrecisionAttemptsList
 *    рендерит свою плашку — здесь проверяем сам факт + что header-CTA на
 *    месте).
 *  - Toggle hideRetained — намеренно отсутствует (ADR-057 §4).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, waitFor } from '@testing-library/react';
import type { PrecisionAttemptsListResponse } from '@kingside/shared';
import { renderWithProviders, screen } from '../test/test-utils';

const authValue: { user: { id: string; username: string } | null } = {
  user: { id: 'u1', username: 'tester' },
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authValue.user, loading: false }),
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
  },
}));

// Chessboard в jsdom тяжёл и в этих тестах не нужен — на странице
// `/history` `PrecisionAttemptsList` рендерит превью для каждой строки.
vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { position: string } }) => (
    <div data-testid="chessboard-mock" data-fen={options.position} />
  ),
}));

import { PrecisionHistoryPage } from './PrecisionHistoryPage';

function makeItem(
  id: string,
  solved: boolean,
): PrecisionAttemptsListResponse['items'][number] {
  return {
    attemptId: id,
    puzzleId: `p-${id}`,
    puzzleFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    attemptedAt: '2026-05-10T12:00:00Z',
    solved,
    endReason: solved ? 'win' : 'lose-wdl',
    halfMovesPlayed: 6,
    accuracyPercent: 80,
    classCounts: {
      best: 3,
      good: 1,
      inaccuracy: 1,
      mistake: 1,
      blunder: 0,
    },
  };
}

beforeEach(() => {
  authValue.user = { id: 'u1', username: 'tester' };
  apiGet.mockReset();
});

describe('PrecisionHistoryPage', () => {
  it('гостю показывает CTA login, список и header-CTA скрыты', () => {
    authValue.user = null;
    renderWithProviders(<PrecisionHistoryPage />, {
      route: '/precision/history',
    });

    const root = screen.getByTestId('precision-history-page');
    expect(root.getAttribute('data-auth')).toBe('guest');

    expect(screen.getByTestId('precision-history-guest-cta')).toBeTruthy();
    expect(
      screen.getByTestId('precision-history-guest-cta-link').getAttribute('href'),
    ).toBe('/login');

    // Список не отрисован.
    expect(screen.queryByTestId('precision-attempts')).toBeNull();
    // Header-CTA «Начать тренировку» только для авторизованных.
    expect(screen.queryByTestId('precision-history-start-cta')).toBeNull();

    // SubNav без пунктов «Прогресс»/«История» (они auth-only).
    expect(screen.getByTestId('precision-subnav')).toBeTruthy();
    expect(screen.queryByTestId('precision-subnav-history')).toBeNull();
  });

  it('авторизованному рендерит SubNav (active=История) + список + header-CTA', async () => {
    apiGet.mockResolvedValue({
      items: [makeItem('a1', true), makeItem('a2', false)],
      total: 2,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionHistoryPage />, {
      route: '/precision/history',
    });

    expect(
      screen.getByTestId('precision-history-page').getAttribute('data-auth'),
    ).toBe('user');

    // Active SubNav pointer.
    expect(
      screen.getByTestId('precision-subnav-history').getAttribute('data-active'),
    ).toBe('true');
    expect(
      screen.getByTestId('precision-subnav-training').getAttribute('data-active'),
    ).toBe('false');

    // Header-CTA → /precision.
    const startCta = screen.getByTestId('precision-history-start-cta');
    expect(startCta.getAttribute('href')).toBe('/precision');

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-attempts').getAttribute('data-state'),
      ).toBe('ready');
    });

    expect(screen.queryByTestId('precision-history-guest-cta')).toBeNull();
  });

  it('фильтры списка переключают видимые строки (Удержано / Упущено)', async () => {
    apiGet.mockResolvedValue({
      items: [
        makeItem('a1', true),
        makeItem('a2', false),
        makeItem('a3', true),
      ],
      total: 3,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionHistoryPage />, {
      route: '/precision/history',
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-attempts').getAttribute('data-state'),
      ).toBe('ready');
    });

    // По умолчанию — все 3 строки.
    expect(screen.getByTestId('precision-attempts-row-a1')).toBeTruthy();
    expect(screen.getByTestId('precision-attempts-row-a2')).toBeTruthy();
    expect(screen.getByTestId('precision-attempts-row-a3')).toBeTruthy();

    // Переключаем на «Удержано» (solved=true → 2 строки).
    fireEvent.click(screen.getByTestId('precision-attempts-filter-preserved'));
    expect(screen.getByTestId('precision-attempts-row-a1')).toBeTruthy();
    expect(screen.queryByTestId('precision-attempts-row-a2')).toBeNull();
    expect(screen.getByTestId('precision-attempts-row-a3')).toBeTruthy();

    // «Упущено» (solved=false → 1 строка).
    fireEvent.click(screen.getByTestId('precision-attempts-filter-lost'));
    expect(screen.queryByTestId('precision-attempts-row-a1')).toBeNull();
    expect(screen.getByTestId('precision-attempts-row-a2')).toBeTruthy();
    expect(screen.queryByTestId('precision-attempts-row-a3')).toBeNull();
  });

  it('пагинация: «Загрузить ещё» дёргает API с offset', async () => {
    // total=25, первая страница 20, вторая 5.
    const page1 = Array.from({ length: 20 }, (_, i) =>
      makeItem(`p1-${i}`, i % 2 === 0),
    );
    const page2 = Array.from({ length: 5 }, (_, i) =>
      makeItem(`p2-${i}`, i % 2 === 0),
    );

    apiGet.mockImplementation((url: string) => {
      if (url.includes('offset=0')) {
        return Promise.resolve({ items: page1, total: 25 });
      }
      if (url.includes('offset=20')) {
        return Promise.resolve({ items: page2, total: 25 });
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });

    renderWithProviders(<PrecisionHistoryPage />, {
      route: '/precision/history',
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-attempts').getAttribute('data-loaded'),
      ).toBe('20');
    });

    fireEvent.click(screen.getByTestId('precision-attempts-load-more'));

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-attempts').getAttribute('data-loaded'),
      ).toBe('25');
    });

    // Кнопка «Загрузить ещё» должна исчезнуть (loaded === total).
    expect(screen.queryByTestId('precision-attempts-load-more')).toBeNull();
  });

  it('empty-state при 0 попыток: плашка от списка + header-CTA «Начать тренировку»', async () => {
    apiGet.mockResolvedValue({
      items: [],
      total: 0,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionHistoryPage />, {
      route: '/precision/history',
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-attempts').getAttribute('data-state'),
      ).toBe('empty');
    });

    // Empty-плашка списка.
    expect(screen.getByTestId('precision-attempts-empty')).toBeTruthy();

    // Header-CTA остался на месте (всегда видна для auth).
    expect(
      screen.getByTestId('precision-history-start-cta').getAttribute('href'),
    ).toBe('/precision');
  });

  it('toggle hideRetained отсутствует на странице (ADR-057 §4)', async () => {
    apiGet.mockResolvedValue({
      items: [makeItem('a1', true)],
      total: 1,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionHistoryPage />, {
      route: '/precision/history',
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-attempts').getAttribute('data-state'),
      ).toBe('ready');
    });

    // Toggle с /precision не переехал — фильтры списка покрывают функционал.
    expect(screen.queryByTestId('precision-hide-preserved')).toBeNull();
  });
});
