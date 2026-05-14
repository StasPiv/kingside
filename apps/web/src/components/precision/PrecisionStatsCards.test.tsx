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

  // KS-3005 (F4): карточка «Средний балл».
  describe('Avg score card (KS-3005)', () => {
    it('рендерится при avgScore !== null с stack-bar по 5 сегментам', async () => {
      const fetcher = vi.fn().mockResolvedValue(
        makeStats({
          avgScore: 4.2,
          avgScorePct: 84,
          scoreDistribution: {
            stars1: 1,
            stars2: 0,
            stars3: 2,
            stars4: 3,
            stars5: 4,
          },
        }),
      );
      renderWithProviders(<PrecisionStatsCards fetcher={fetcher} />);

      const card = await screen.findByTestId('precision-stats-avg-score');
      expect(card.textContent).toContain('4.2/5');
      expect(card.getAttribute('data-avg-score')).toBe('4.2');
      expect(card.getAttribute('data-total')).toBe('10');

      const bar = screen.getByTestId('precision-stats-avg-score-bar');
      expect(bar).toBeTruthy();
      expect(
        screen
          .getByTestId('precision-stats-avg-score-seg-stars5')
          .getAttribute('data-count'),
      ).toBe('4');
      expect(
        screen
          .getByTestId('precision-stats-avg-score-seg-stars2')
          .getAttribute('data-count'),
      ).toBe('0');
    });

    it('НЕ рендерится при avgScore=null', async () => {
      const fetcher = vi.fn().mockResolvedValue(
        makeStats({ avgScore: null, avgScorePct: null }),
      );
      renderWithProviders(<PrecisionStatsCards fetcher={fetcher} />);

      await waitFor(() => {
        expect(
          screen.getByTestId('precision-stats').getAttribute('data-state'),
        ).toBe('ready');
      });
      expect(screen.queryByTestId('precision-stats-avg-score')).toBeNull();
    });

    it('avgScore без distribution → fallback-hint "No graded attempts yet"', async () => {
      const fetcher = vi.fn().mockResolvedValue(
        makeStats({
          avgScore: 3.5,
          avgScorePct: 70,
          scoreDistribution: {
            stars1: 0,
            stars2: 0,
            stars3: 0,
            stars4: 0,
            stars5: 0,
          },
        }),
      );
      renderWithProviders(<PrecisionStatsCards fetcher={fetcher} />);

      const card = await screen.findByTestId('precision-stats-avg-score');
      expect(card.textContent).toContain('3.5/5');
      expect(
        screen.queryByTestId('precision-stats-avg-score-bar'),
      ).toBeNull();
      expect(card.textContent).toContain('No graded attempts yet');
    });

    it('avgScore=3.95 округляется и форматируется как 4.0/5', async () => {
      const fetcher = vi.fn().mockResolvedValue(
        makeStats({
          avgScore: 3.95,
          avgScorePct: 79,
          scoreDistribution: {
            stars1: 0,
            stars2: 0,
            stars3: 0,
            stars4: 5,
            stars5: 5,
          },
        }),
      );
      renderWithProviders(<PrecisionStatsCards fetcher={fetcher} />);

      const card = await screen.findByTestId('precision-stats-avg-score');
      expect(card.textContent).toContain('4.0/5');
    });
  });
});
