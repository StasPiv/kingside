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

/** KS-3024: helper для теста marker'а — даты по обе стороны от 2026-05-15. */
function makeRespAroundMigration(): PrecisionTrendsResponse {
  return {
    bucket: 'week',
    points: [
      { bucketStart: '2026-05-01T00:00:00Z', attempts: 5, preserved: 3, avgAccuracyPercent: 60, avgWdlLeakPerMove: 0.05 },
      { bucketStart: '2026-05-08T00:00:00Z', attempts: 6, preserved: 4, avgAccuracyPercent: 65, avgWdlLeakPerMove: 0.04 },
      { bucketStart: '2026-05-22T00:00:00Z', attempts: 7, preserved: 6, avgAccuracyPercent: 85, avgWdlLeakPerMove: 0.02 },
      { bucketStart: '2026-05-29T00:00:00Z', attempts: 8, preserved: 7, avgAccuracyPercent: 88, avgWdlLeakPerMove: 0.015 },
    ],
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

  // KS-3024 / ADR-066 §7.3 (F1): vertical marker даты миграции
  // классификации cp-loss → WDL-loss.
  describe('migration marker (KS-3024)', () => {
    it('даты вокруг 2026-05-15 → marker отрисован с data-migration-date', async () => {
      const fetcher = vi.fn().mockResolvedValue(makeRespAroundMigration());
      renderWithProviders(<PrecisionTrendsChart fetcher={fetcher} />);
      const marker = await screen.findByTestId(
        'precision-trends-migration-marker',
      );
      expect(marker.getAttribute('data-migration-date')).toBe('2026-05-15');
      expect(
        screen.getByTestId('precision-trends-migration-marker-label')
          .textContent,
      ).toContain('Method update');
    });

    it('все даты ДО миграции → marker не рисуется', async () => {
      // 2026-04-* < 2026-05-15.
      const fetcher = vi.fn().mockResolvedValue(makeResp('week', 4));
      renderWithProviders(<PrecisionTrendsChart fetcher={fetcher} />);
      await waitFor(() => {
        expect(
          screen.getByTestId('precision-trends').getAttribute('data-state'),
        ).toBe('ready');
      });
      expect(
        screen.queryByTestId('precision-trends-migration-marker'),
      ).toBeNull();
    });

    it('одна точка → marker не рисуется (нечего интерполировать)', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        bucket: 'week' as const,
        points: [
          {
            bucketStart: '2026-05-15T00:00:00Z',
            attempts: 5,
            preserved: 3,
            avgAccuracyPercent: 70,
            avgWdlLeakPerMove: 0.03,
          },
        ],
      });
      renderWithProviders(<PrecisionTrendsChart fetcher={fetcher} />);
      await waitFor(() => {
        expect(
          screen.getByTestId('precision-trends').getAttribute('data-state'),
        ).toBe('ready');
      });
      expect(
        screen.queryByTestId('precision-trends-migration-marker'),
      ).toBeNull();
    });
  });
});
