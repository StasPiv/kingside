import { describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import type { BlindBoardStatsResponse } from '@kingside/shared';
import { BlindBoardStatsCards } from './BlindBoardStatsCards';

const STATS: BlindBoardStatsResponse = {
  totalSessions: 8,
  bestStreak: 17,
  currentStreak: 4,
  maxLevelReached: 3,
  avgRoundsPerSession: 12.4,
  wrongAnswerCount: 6,
  deadEndCount: 0,
};

describe('<BlindBoardStatsCards> KS-3511', () => {
  it('empty (totalSessions=0)', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ...STATS, totalSessions: 0 });
    renderWithProviders(<BlindBoardStatsCards fetcher={fetcher} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-stats-placeholder'),
      ).toBeInTheDocument(),
    );
  });

  it('ready: 4 карточки', async () => {
    const fetcher = vi.fn().mockResolvedValue(STATS);
    renderWithProviders(<BlindBoardStatsCards fetcher={fetcher} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-stats-best-streak'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('blind-board-stats-best-streak').textContent,
    ).toContain('17');
    expect(
      screen.getByTestId('blind-board-stats-current-streak').textContent,
    ).toContain('4');
    expect(
      screen.getByTestId('blind-board-stats-max-level').textContent,
    ).toContain('L3');
    expect(
      screen.getByTestId('blind-board-stats-avg-rounds').textContent,
    ).toContain('12.4');
  });
});
