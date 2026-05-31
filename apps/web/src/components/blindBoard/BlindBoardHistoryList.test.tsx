import { describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import type {
  BlindBoardHistoryItem,
  BlindBoardHistoryResponse,
} from '@kingside/shared';
import { BlindBoardHistoryList } from './BlindBoardHistoryList';

/**
 * KS-3517. Строка истории blind-board теперь Link на review-страницу
 * `/blind-board/sessions/:id`.
 */

function item(
  id: string,
  overrides: Partial<BlindBoardHistoryItem> = {},
): BlindBoardHistoryItem {
  return {
    id,
    level: 2,
    bestStreak: 7,
    finishReason: 'wrong-answer',
    startedAt: '2026-05-30T10:00:00.000Z',
    finishedAt: '2026-05-30T10:03:00.000Z',
    ...overrides,
  };
}

describe('<BlindBoardHistoryList> KS-3530: удаление сессии', () => {
  it('🗑 → confirm true → deleter(id) вызывается', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValue({
      items: [item('bb-x')],
      nextCursor: null,
      hasMore: false,
    } as BlindBoardHistoryResponse);
    const deleter = vi.fn().mockResolvedValue(undefined);
    const confirmFn = vi.fn().mockReturnValue(true);
    renderWithProviders(
      <BlindBoardHistoryList
        fetcher={fetcher}
        deleter={deleter}
        confirmFn={confirmFn}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-history-delete-bb-x'),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('blind-board-history-delete-bb-x'));
    expect(confirmFn).toHaveBeenCalled();
    expect(deleter).toHaveBeenCalledWith('bb-x');
  });
});

describe('<BlindBoardHistoryList> KS-3517', () => {
  it('каждая строка — Link на /blind-board/sessions/:id', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [item('bb-1'), item('bb-2', { level: 3, bestStreak: 9 })],
      nextCursor: null,
      hasMore: false,
    } as BlindBoardHistoryResponse);
    renderWithProviders(<BlindBoardHistoryList fetcher={fetcher} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-history-link-bb-1'),
      ).toBeInTheDocument(),
    );
    const link1 = screen.getByTestId('blind-board-history-link-bb-1');
    expect(link1.tagName).toBe('A');
    expect(link1.getAttribute('href')).toBe('/blind-board/sessions/bb-1');
    const link2 = screen.getByTestId('blind-board-history-link-bb-2');
    expect(link2.getAttribute('href')).toBe('/blind-board/sessions/bb-2');
    // Содержимое сохранено (level, streak).
    expect(link1.textContent).toContain('L2');
    expect(link1.textContent).toContain('streak 7');
  });
});
