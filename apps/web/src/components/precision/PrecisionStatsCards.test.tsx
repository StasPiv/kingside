/**
 * KS-2744 / ADR-057. Тесты `<PrecisionStatsCards />`.
 *
 * Покрытие:
 *  - 4 карточки при totalAttempts > 0 (ready);
 *  - placeholder при totalAttempts = 0 (empty);
 *  - placeholder при 404 (fetcher → null) (empty);
 *  - формат значений (accuracy %, WDL leak %, preserved/lost счёт).
 */

import { describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import {
  PrecisionStatsCards,
  type PrecisionStatsCardsResponse,
} from './PrecisionStatsCards';

function makeStats(
  overrides: Partial<PrecisionStatsCardsResponse> = {},
): PrecisionStatsCardsResponse {
  return {
    totalAttempts: 10,
    preservedCount: 7,
    avgAccuracyPercent: 82.4,
    avgWdlLeakPerMove: 0.043,
    avgHalfMovesUntilFirstMistake: 5.6,
    ...overrides,
  };
}

describe('<PrecisionStatsCards>', () => {
  it('рендерит 4 карточки при totalAttempts > 0', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeStats());
    renderWithProviders(<PrecisionStatsCards fetcher={fetcher} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-stats').getAttribute('data-state'),
      ).toBe('ready');
    });

    expect(screen.getByTestId('precision-stats-accuracy')).toBeTruthy();
    expect(screen.getByTestId('precision-stats-preserved')).toBeTruthy();
    expect(screen.getByTestId('precision-stats-leak')).toBeTruthy();
    expect(screen.getByTestId('precision-stats-first-mistake')).toBeTruthy();
    expect(screen.queryByTestId('precision-stats-placeholder')).toBeNull();
  });

  it('формат значений: accuracy %, preserved/lost, WDL-leak %, first mistake', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeStats({
        totalAttempts: 10,
        preservedCount: 7,
        avgAccuracyPercent: 82.4,
        avgWdlLeakPerMove: 0.043,
        avgHalfMovesUntilFirstMistake: 5.6,
      }),
    );
    renderWithProviders(<PrecisionStatsCards fetcher={fetcher} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-stats').getAttribute('data-state'),
      ).toBe('ready');
    });

    expect(screen.getByTestId('precision-stats-accuracy').textContent).toContain(
      '82%',
    );
    expect(
      screen.getByTestId('precision-stats-preserved').textContent,
    ).toContain('7 / 3');
    expect(screen.getByTestId('precision-stats-leak').textContent).toContain(
      '4.3%',
    );
    expect(
      screen.getByTestId('precision-stats-first-mistake').textContent,
    ).toContain('5.6');
  });

  it('placeholder при totalAttempts = 0', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeStats({
        totalAttempts: 0,
        preservedCount: 0,
        avgAccuracyPercent: null,
        avgWdlLeakPerMove: null,
        avgHalfMovesUntilFirstMistake: null,
      }),
    );
    renderWithProviders(<PrecisionStatsCards fetcher={fetcher} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-stats').getAttribute('data-state'),
      ).toBe('empty');
    });

    expect(screen.getByTestId('precision-stats-placeholder')).toBeTruthy();
    expect(screen.queryByTestId('precision-stats-accuracy')).toBeNull();
  });

  it('placeholder при 404 (fetcher → null)', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    renderWithProviders(<PrecisionStatsCards fetcher={fetcher} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-stats').getAttribute('data-state'),
      ).toBe('empty');
    });

    expect(screen.getByTestId('precision-stats-placeholder')).toBeTruthy();
  });

  it('placeholder при reject (fetcher бросает)', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    renderWithProviders(<PrecisionStatsCards fetcher={fetcher} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-stats').getAttribute('data-state'),
      ).toBe('empty');
    });

    expect(screen.getByTestId('precision-stats-placeholder')).toBeTruthy();
  });
});
