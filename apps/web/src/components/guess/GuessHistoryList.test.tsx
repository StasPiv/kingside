import { describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import type { GuessHistoryResponse, GuessSessionDto } from '@kingside/shared';
import { GuessHistoryList } from './GuessHistoryList';

/**
 * KS-3514. Клик по строке истории идёт на /guess/sessions/:id (review-
 * страница). До KS-3513 был Link на тот же путь, но не было самой
 * страницы; KS-3513 временно переключал на POST /to-analysis (работает
 * только для finished); KS-3514 вернул `<Link>` уже на готовую review.
 */

function session(id: string, overrides: Partial<GuessSessionDto> = {}): GuessSessionDto {
  return {
    id,
    gameSource: 'pgn',
    gameRef: null,
    side: 'white',
    status: 'finished',
    userAccuracy: 80,
    playerAccuracy: 65,
    userStars: 4,
    score: 256,
    bestStreak: 5,
    betterThanPlayerCount: 2,
    startedAt: '2026-05-30T10:00:00.000Z',
    finishedAt: '2026-05-30T10:10:00.000Z',
    ...overrides,
  };
}

describe('<GuessHistoryList> KS-3530: удаление сессии', () => {
  it('🗑 → confirm true → deleter(id) + рефреш списка', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const user = userEvent.setup();
    let call = 0;
    const fetcher = vi.fn().mockImplementation(() => {
      call += 1;
      // Первый прогон — две сессии, после удаления — одна.
      if (call === 1) {
        return Promise.resolve({
          items: [session('s-1'), session('s-2')],
          total: 2,
        } as GuessHistoryResponse);
      }
      return Promise.resolve({
        items: [session('s-2')],
        total: 1,
      } as GuessHistoryResponse);
    });
    const deleter = vi.fn().mockResolvedValue(undefined);
    const confirmFn = vi.fn().mockReturnValue(true);
    renderWithProviders(
      <GuessHistoryList
        fetcher={fetcher}
        deleter={deleter}
        confirmFn={confirmFn}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-history-delete-s-1')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('guess-history-delete-s-1'));
    expect(confirmFn).toHaveBeenCalled();
    expect(deleter).toHaveBeenCalledWith('s-1');
    await waitFor(() =>
      expect(screen.queryByTestId('guess-history-item-s-1')).toBeNull(),
    );
    expect(screen.getByTestId('guess-history-item-s-2')).toBeInTheDocument();
  });

  it('🗑 → confirm false → deleter НЕ вызывается', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValue({
      items: [session('s-3')],
      total: 1,
    } as GuessHistoryResponse);
    const deleter = vi.fn();
    const confirmFn = vi.fn().mockReturnValue(false);
    renderWithProviders(
      <GuessHistoryList
        fetcher={fetcher}
        deleter={deleter}
        confirmFn={confirmFn}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-history-delete-s-3')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('guess-history-delete-s-3'));
    expect(confirmFn).toHaveBeenCalled();
    expect(deleter).not.toHaveBeenCalled();
  });
});

describe('<GuessHistoryList> KS-3514', () => {
  it('строка истории — Link на /guess/sessions/:id', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [session('s-42')],
      total: 1,
    } as GuessHistoryResponse);
    renderWithProviders(<GuessHistoryList fetcher={fetcher} />);
    await waitFor(() =>
      expect(screen.getByTestId('guess-history-link-s-42')).toBeInTheDocument(),
    );
    const link = screen.getByTestId('guess-history-link-s-42');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/guess/sessions/s-42');
  });

  it('active-сессия тоже линкуется на review', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [session('s-active', { status: 'active', userAccuracy: null, userStars: null })],
      total: 1,
    } as GuessHistoryResponse);
    renderWithProviders(<GuessHistoryList fetcher={fetcher} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('guess-history-link-s-active'),
      ).toBeInTheDocument(),
    );
    expect(
      screen
        .getByTestId('guess-history-link-s-active')
        .getAttribute('href'),
    ).toBe('/guess/sessions/s-active');
  });
});
