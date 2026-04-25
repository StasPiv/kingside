import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UserMistakeAggregate } from '@kingside/shared';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { PuzzleMistakesPage } from './PuzzleMistakesPage';

/**
 * KS-1928: страница `/puzzles/mistakes` — полный список тем дневника.
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: { getAggregates: vi.fn(), getRecommendations: vi.fn() },
}));

vi.mock('../api/puzzleMistakesApi', () => ({
  puzzleMistakesApi: apiMock,
}));

function agg(partial: Partial<UserMistakeAggregate>): UserMistakeAggregate {
  return {
    theme: 'fork',
    count: 5,
    lastOccurredAt: '2026-04-22T00:00:00.000Z',
    ...partial,
  } as UserMistakeAggregate;
}

beforeEach(() => {
  apiMock.getAggregates.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<PuzzleMistakesPage>', () => {
  it('loading state', () => {
    apiMock.getAggregates.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<PuzzleMistakesPage />, { route: '/puzzles/mistakes' });
    expect(screen.getByTestId('mistakes-loading')).toBeInTheDocument();
  });

  it('error state', async () => {
    apiMock.getAggregates.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<PuzzleMistakesPage />, { route: '/puzzles/mistakes' });
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-error')).toBeInTheDocument(),
    );
  });

  it('empty state', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [],
      totalThemes: 0,
      since: null,
      limit: 100,
    });
    renderWithProviders(<PuzzleMistakesPage />, { route: '/puzzles/mistakes' });
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-empty')).toBeInTheDocument(),
    );
  });

  it('рендерит таблицу + CTA на /puzzles/mistakes-practice', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [agg({ theme: 'fork', count: 12 })],
      totalThemes: 1,
      since: null,
      limit: 100,
    });
    renderWithProviders(<PuzzleMistakesPage />, { route: '/puzzles/mistakes' });
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-page-table')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mistakes-page-row-fork')).toBeInTheDocument();
    expect(screen.getByTestId('mistakes-page-cta-fork')).toHaveAttribute(
      'href',
      '/puzzles/mistakes-practice?theme=fork',
    );
  });

  it('back-link → /puzzles', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [],
      totalThemes: 0,
      since: null,
      limit: 100,
    });
    renderWithProviders(<PuzzleMistakesPage />, { route: '/puzzles/mistakes' });
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-page-back')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mistakes-page-back')).toHaveAttribute(
      'href',
      '/puzzles',
    );
  });
});
