import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionRatingPill } from './PrecisionRatingPill';

/**
 * KS-3350 (ADR-079 §3.5). Тесты pill'а с precision-рейтингом.
 *
 * Покрытие:
 *  - guest → не рендерится.
 *  - auth + успешный fetch → pill отображает rating + RD.
 *  - loading → pill-скелетон с прочерком.
 *  - ошибка fetch → pill не рендерится (graceful).
 *  - округление float-значений Glicko-1 до целого.
 */

const authMock: { user: { id: string; username: string } | null } = {
  user: { id: 'u1', username: 'tester' },
};
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: authMock.user,
    loading: false,
    token: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

const getMyRating = vi.fn();
vi.mock('../../api/precisionApi', () => ({
  precisionApi: {
    getMyRating: (...args: unknown[]) => getMyRating(...args),
  },
}));

beforeEach(() => {
  authMock.user = { id: 'u1', username: 'tester' };
  getMyRating.mockReset();
});

describe('<PrecisionRatingPill> KS-3350', () => {
  it('guest → не рендерит pill', () => {
    authMock.user = null;
    getMyRating.mockResolvedValue({
      rating: 1500,
      deviation: 350,
      attempts: 0,
      lastAttemptAt: null,
    });
    renderWithProviders(<PrecisionRatingPill />);
    expect(screen.queryByTestId('precision-rating-pill')).toBeNull();
  });

  it('auth + success → pill отображает rating и RD', async () => {
    getMyRating.mockResolvedValue({
      rating: 1487,
      deviation: 42,
      attempts: 25,
      lastAttemptAt: '2026-05-20T10:00:00Z',
    });
    renderWithProviders(<PrecisionRatingPill />);
    await waitFor(() => {
      const pill = screen.getByTestId('precision-rating-pill');
      expect(pill.getAttribute('data-state')).toBe('ready');
    });
    expect(
      screen.getByTestId('precision-rating-pill-value').textContent,
    ).toBe('1487');
    expect(
      screen.getByTestId('precision-rating-pill-deviation').textContent,
    ).toBe('(±42)');
    const pill = screen.getByTestId('precision-rating-pill');
    expect(pill.getAttribute('data-rating')).toBe('1487');
    expect(pill.getAttribute('data-deviation')).toBe('42');
  });

  it('loading → скелетон с прочерком', () => {
    let resolveRating: (v: unknown) => void = () => {};
    getMyRating.mockReturnValue(
      new Promise((res) => {
        resolveRating = res;
      }),
    );
    renderWithProviders(<PrecisionRatingPill />);
    // До resolve — рендерится pill в состоянии loading.
    const pill = screen.getByTestId('precision-rating-pill');
    expect(pill.getAttribute('data-state')).toBe('loading');
    expect(
      screen.getByTestId('precision-rating-pill-value').textContent,
    ).toBe('—');
    resolveRating({
      rating: 1500,
      deviation: 350,
      attempts: 0,
      lastAttemptAt: null,
    });
  });

  it('ошибка fetch → pill не рендерится', async () => {
    getMyRating.mockRejectedValue(new Error('boom'));
    renderWithProviders(<PrecisionRatingPill />);
    await waitFor(() => {
      expect(screen.queryByTestId('precision-rating-pill')).toBeNull();
    });
  });

  it('float rating от Glicko → округление до целого', async () => {
    getMyRating.mockResolvedValue({
      rating: 1487.62,
      deviation: 41.93,
      attempts: 10,
      lastAttemptAt: '2026-05-20T10:00:00Z',
    });
    renderWithProviders(<PrecisionRatingPill />);
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-rating-pill').getAttribute('data-state'),
      ).toBe('ready');
    });
    expect(
      screen.getByTestId('precision-rating-pill-value').textContent,
    ).toBe('1488');
    expect(
      screen.getByTestId('precision-rating-pill-deviation').textContent,
    ).toBe('(±42)');
  });

  it('tooltip — Glicko-1 hint', async () => {
    getMyRating.mockResolvedValue({
      rating: 1500,
      deviation: 350,
      attempts: 0,
      lastAttemptAt: null,
    });
    renderWithProviders(<PrecisionRatingPill />);
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-rating-pill').getAttribute('data-state'),
      ).toBe('ready');
    });
    const pill = screen.getByTestId('precision-rating-pill');
    expect(pill.getAttribute('title')).toMatch(/Glicko/i);
  });
});
