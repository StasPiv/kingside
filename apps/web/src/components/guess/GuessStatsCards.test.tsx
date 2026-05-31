import { describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import type { GuessStatsResponse } from '@kingside/shared';
import { GuessStatsCards } from './GuessStatsCards';

/**
 * KS-3510. GuessStatsCards: empty-state на 0 сессий, 4 карточки при
 * наличии данных.
 */

const STATS: GuessStatsResponse = {
  totalSessions: 12,
  avgUserAccuracy: 78.4,
  avgPlayerAccuracy: 72.1,
  winsVsPlayer: 7,
  avgStars: 3.6,
  totalScore: 940,
  bestStreak: 11,
  totalBetterMoves: 4,
};

describe('<GuessStatsCards> KS-3510', () => {
  it('totalSessions=0 → placeholder', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ...STATS,
      totalSessions: 0,
    } as GuessStatsResponse);
    renderWithProviders(<GuessStatsCards fetcher={fetcher} />);
    await waitFor(() =>
      expect(screen.getByTestId('guess-stats-placeholder')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('guess-stats').getAttribute('data-state')).toBe(
      'empty',
    );
  });

  it('totalSessions>0 → 4 карточки', async () => {
    const fetcher = vi.fn().mockResolvedValue(STATS);
    renderWithProviders(<GuessStatsCards fetcher={fetcher} />);
    await waitFor(() =>
      expect(screen.getByTestId('guess-stats-accuracy')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('guess-stats-accuracy').textContent).toContain(
      '78%',
    );
    expect(screen.getByTestId('guess-stats-wins').textContent).toContain(
      '7 / 12',
    );
    expect(screen.getByTestId('guess-stats-best-streak').textContent).toContain(
      '11',
    );
    expect(screen.getByTestId('guess-stats-avg-stars').textContent).toContain(
      '3.6/5',
    );
  });

  it('fetcher null → placeholder', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    renderWithProviders(<GuessStatsCards fetcher={fetcher} />);
    await waitFor(() =>
      expect(screen.getByTestId('guess-stats-placeholder')).toBeInTheDocument(),
    );
  });
});
