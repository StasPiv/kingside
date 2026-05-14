import { describe, it, expect, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import type { PrecisionTrendsResponse } from '@kingside/shared';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionTrendsChart } from './PrecisionTrendsChart';

/**
 * KS-2728 — график тренда accuracy.
 * KS-3040 — переключатель «Неделя/Месяц» теперь окно (today-6/today-29 ...
 * today), backend всегда зовут с `bucket=day&since=&until=`. Точки
 * расставлены по реальной дате внутри окна, X-подписи — границы окна.
 */

// KS-3040: фиксируем «сегодня» для детерминированности окна. 14.05.2026
// (середина недели) — окно week = 08.05..14.05, month = 15.04..14.05.
const FIXED_NOW = new Date('2026-05-14T12:00:00Z');

// Геометрия SVG (синхронно с PrecisionTrendsChart). Помогает проверить,
// что точка не «прыгает» в центр диаграммы.
const VB_CENTER = 200; // 400 / 2

function makeResp(
  bucket: 'week' | 'month' | 'day',
  pointsCount: number,
  startISO = '2026-04-01T00:00:00Z',
): PrecisionTrendsResponse {
  const start = new Date(startISO);
  return {
    bucket,
    points: Array.from({ length: pointsCount }, (_, i) => {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      return {
        bucketStart: d.toISOString(),
        attempts: 5 + i,
        preserved: 3 + i,
        avgAccuracyPercent: 60 + i * 5,
        avgWdlLeakPerMove: 0.05 - i * 0.005,
      };
    }),
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
    const fetcher = vi.fn().mockResolvedValue(makeResp('day', 3));
    renderWithProviders(
      <PrecisionTrendsChart fetcher={fetcher} now={FIXED_NOW} />,
    );
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
    // KS-3040: X-подписи — границы окна, не min/max точек.
    expect(screen.getByTestId('precision-trends-x-start')).toBeTruthy();
    expect(screen.getByTestId('precision-trends-x-end')).toBeTruthy();
  });

  it('пустой points → empty-state', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeResp('day', 0));
    renderWithProviders(
      <PrecisionTrendsChart fetcher={fetcher} now={FIXED_NOW} />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-trends').getAttribute('data-state'),
      ).toBe('empty');
    });
    expect(screen.getByTestId('precision-trends-empty')).toBeTruthy();
  });

  it('переключатель week→month вызывает повторный fetch с новым окном', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeResp('day', 2));
    renderWithProviders(
      <PrecisionTrendsChart fetcher={fetcher} now={FIXED_NOW} />,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    // Первый вызов — week, окно 7 дней.
    const [firstMode, firstRange] = fetcher.mock.calls[0];
    expect(firstMode).toBe('week');
    const weekDays =
      (firstRange.until.getTime() - firstRange.since.getTime()) /
      (24 * 60 * 60 * 1000);
    expect(weekDays).toBe(7);

    fireEvent.click(screen.getByTestId('precision-trends-bucket-month'));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const [secondMode, secondRange] = fetcher.mock.calls[1];
    expect(secondMode).toBe('month');
    const monthDays =
      (secondRange.until.getTime() - secondRange.since.getTime()) /
      (24 * 60 * 60 * 1000);
    expect(monthDays).toBe(30);
  });

  it('ошибка fetch → error-state с retry', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('500'));
    renderWithProviders(
      <PrecisionTrendsChart fetcher={fetcher} now={FIXED_NOW} />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-trends').getAttribute('data-state'),
      ).toBe('error');
    });
    expect(screen.getByTestId('precision-trends-retry')).toBeTruthy();
  });

  // KS-3040 (баг 2): окно «Неделя» — 7 дней (today-6 ... today), даже
  // если внутри только одна точка с данными. Подписи X-оси берутся
  // из границ окна, а не из bucketStart единственной точки.
  describe('KS-3040 окно today-6 ... today (week mode)', () => {
    it('одна точка в окне неделя — X-подписи показывают границы окна, не дату точки', async () => {
      // Одна точка ровно на today (14.05.2026).
      const fetcher = vi.fn().mockResolvedValue({
        bucket: 'day' as const,
        points: [
          {
            bucketStart: '2026-05-14T00:00:00Z',
            attempts: 39,
            preserved: 12,
            avgAccuracyPercent: 67,
            avgWdlLeakPerMove: 0.04,
          },
        ],
      });
      renderWithProviders(
        <PrecisionTrendsChart fetcher={fetcher} now={FIXED_NOW} />,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('precision-trends').getAttribute('data-state'),
        ).toBe('ready');
      });
      // Окно = today-6 ... today (полуоткрытое: until — полночь
      // следующего после today). Не сверяем ISO напрямую, чтобы тест
      // не зависел от TZ env (`computeWindow` использует local-midnight,
      // что в UTC сдвигает ISO на ±N часов). Проверяем семантику:
      // - длина окна = 7 дней;
      // - until — 1 день после today;
      // - since = until - 7 дней.
      const section = screen.getByTestId('precision-trends');
      const since = new Date(section.getAttribute('data-window-since')!);
      const until = new Date(section.getAttribute('data-window-until')!);
      const dayMs = 24 * 60 * 60 * 1000;
      expect((until.getTime() - since.getTime()) / dayMs).toBe(7);
      // until > today (14.05.2026 12:00Z) — полночь следующего дня
      // в локали может быть до или после UTC midnight; проверяем
      // только что until находится в пределах 14..15.05 включительно.
      expect(until.getTime()).toBeGreaterThan(
        new Date('2026-05-14T00:00:00Z').getTime(),
      );
      expect(until.getTime()).toBeLessThanOrEqual(
        new Date('2026-05-15T23:59:59Z').getTime(),
      );

      // X-подписи: since = 08.05, until-1d = 14.05. Локализация даты
      // зависит от env, но содержимое не равно одной и той же дате.
      const start = screen.getByTestId('precision-trends-x-start').textContent;
      const end = screen.getByTestId('precision-trends-x-end').textContent;
      expect(start).toBeTruthy();
      expect(end).toBeTruthy();
      expect(start).not.toBe(end);
    });

    it('одна точка где-то в середине окна позиционируется по своей реальной дате (не по центру)', async () => {
      // today = 14.05; точка = 10.05 (4 дня назад из 7). Доля ≈ 3/7.
      const fetcher = vi.fn().mockResolvedValue({
        bucket: 'day' as const,
        points: [
          {
            bucketStart: '2026-05-10T00:00:00Z',
            attempts: 5,
            preserved: 3,
            avgAccuracyPercent: 70,
            avgWdlLeakPerMove: 0.03,
          },
        ],
      });
      renderWithProviders(
        <PrecisionTrendsChart fetcher={fetcher} now={FIXED_NOW} />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('precision-trends').getAttribute('data-state'),
        ).toBe('ready'),
      );
      const point = screen.getByTestId('precision-trends-point-0');
      const cx = parseFloat(
        point.querySelector('circle')!.getAttribute('cx') ?? '0',
      );
      // Окно since=08.05 00:00, until=15.05 00:00 — span = 7 дней.
      // Точка 10.05 00:00 → frac = 2/7. innerW = 400-2*24 = 352.
      // x = 24 + (2/7) * 352 ≈ 124.57.
      expect(cx).toBeGreaterThan(120);
      expect(cx).toBeLessThan(130);
      // НЕ в центре (180 ± маленький допуск): убеждаемся, что
      // одна точка не «стягивается» к середине, как было раньше.
      expect(Math.abs(cx - VB_CENTER)).toBeGreaterThan(30);
    });

    it('week mode зовёт API с bucket=day и окном 7 дней', async () => {
      const fetcher = vi.fn().mockResolvedValue(makeResp('day', 0));
      renderWithProviders(
        <PrecisionTrendsChart fetcher={fetcher} now={FIXED_NOW} />,
      );
      await waitFor(() => expect(fetcher).toHaveBeenCalled());
      const [mode, range] = fetcher.mock.calls[0];
      expect(mode).toBe('week');
      const days =
        (range.until.getTime() - range.since.getTime()) /
        (24 * 60 * 60 * 1000);
      expect(days).toBe(7);
    });
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
