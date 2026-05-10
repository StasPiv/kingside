import { describe, it, expect, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import type { PrecisionTrendsResponse } from '@kingside/shared';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionTrendsChart } from './PrecisionTrendsChart';

/**
 * KS-2728 — график тренда accuracy.
 */

function makeResp(
  bucket: 'week' | 'month',
  pointsCount: number,
): PrecisionTrendsResponse {
  return {
    bucket,
    points: Array.from({ length: pointsCount }, (_, i) => ({
      bucketStart: `2026-04-${(i + 1).toString().padStart(2, '0')}T00:00:00Z`,
      attempts: 5 + i,
      preserved: 3 + i,
      avgAccuracyPercent: 60 + i * 5,
      avgWdlLeakPerMove: 0.05 - i * 0.005,
    })),
  };
}

describe('<PrecisionTrendsChart>', () => {
  it('рендерит линию с 3 точками и 2 X-подписями (даты)', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeResp('week', 3));
    renderWithProviders(<PrecisionTrendsChart fetcher={fetcher} />);
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-trends').getAttribute('data-state'),
      ).toBe('ready');
    });
    expect(
      screen.getByTestId('precision-trends').getAttribute('data-points'),
    ).toBe('3');
    expect(screen.getByTestId('precision-trends-point-0')).toBeTruthy();
    expect(screen.getByTestId('precision-trends-point-2')).toBeTruthy();
  });

  it('пустой points → empty-state', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeResp('week', 0));
    renderWithProviders(<PrecisionTrendsChart fetcher={fetcher} />);
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-trends').getAttribute('data-state'),
      ).toBe('empty');
    });
    expect(screen.getByTestId('precision-trends-empty')).toBeTruthy();
  });

  it('переключатель week→month вызывает повторный fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeResp('week', 2));
    renderWithProviders(<PrecisionTrendsChart fetcher={fetcher} />);
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith('week');
    });
    fireEvent.click(screen.getByTestId('precision-trends-bucket-month'));
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith('month');
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ошибка fetch → error-state с retry', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('500'));
    renderWithProviders(<PrecisionTrendsChart fetcher={fetcher} />);
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-trends').getAttribute('data-state'),
      ).toBe('error');
    });
    expect(screen.getByTestId('precision-trends-retry')).toBeTruthy();
  });
});
