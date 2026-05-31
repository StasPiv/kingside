import { describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';
import type { GuessHistoryResponse, GuessSessionDto } from '@kingside/shared';
import { GuessHistoryList } from './GuessHistoryList';

/**
 * KS-3513 (F-guess hotfix). Клик по строке → guessApi.toAnalysis →
 * navigate(url). До хотфикса был Link на /guess/sessions/:id —
 * маршрут не зарегистрирован, React Router fallback'ил на /.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return { ...actual, useNavigate: () => mockNavigate };
});

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

describe('<GuessHistoryList> KS-3513', () => {
  it('клик по строке вызывает toAnalysis(id) и navigate(url)', async () => {
    const user = userEvent.setup();
    mockNavigate.mockReset();
    const fetcher = vi.fn().mockResolvedValue({
      items: [session('s-1')],
      total: 1,
    } as GuessHistoryResponse);
    const toAnalysis = vi.fn().mockResolvedValue({ url: '/analysis/an-9' });
    renderWithProviders(
      <GuessHistoryList fetcher={fetcher} toAnalysis={toAnalysis} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-history-link-s-1')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('guess-history-link-s-1'));
    expect(toAnalysis).toHaveBeenCalledWith('s-1');
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/analysis/an-9'),
    );
  });

  it('пока идёт toAnalysis — кнопка disabled + aria-busy, повторный клик не дублирует', async () => {
    const user = userEvent.setup();
    mockNavigate.mockReset();
    const fetcher = vi.fn().mockResolvedValue({
      items: [session('s-2'), session('s-3')],
      total: 2,
    } as GuessHistoryResponse);
    // toAnalysis висит — promise не резолвится сразу.
    let resolve!: (v: { url: string }) => void;
    const toAnalysis = vi
      .fn()
      .mockReturnValue(new Promise<{ url: string }>((r) => (resolve = r)));
    renderWithProviders(
      <GuessHistoryList fetcher={fetcher} toAnalysis={toAnalysis} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-history-link-s-2')).toBeInTheDocument(),
    );
    const btn2 = screen.getByTestId(
      'guess-history-link-s-2',
    ) as HTMLButtonElement;
    await user.click(btn2);
    expect(toAnalysis).toHaveBeenCalledTimes(1);
    // обе кнопки залочены — соседняя тоже.
    expect(btn2.disabled).toBe(true);
    expect(btn2.getAttribute('aria-busy')).toBe('true');
    expect(
      (screen.getByTestId('guess-history-link-s-3') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(btn2);
    expect(toAnalysis).toHaveBeenCalledTimes(1);
    // Резолвим — навигация.
    resolve({ url: '/analysis/an-2' });
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/analysis/an-2'),
    );
  });

  it('ошибка toAnalysis — кнопка снова кликабельна', async () => {
    const user = userEvent.setup();
    mockNavigate.mockReset();
    const fetcher = vi.fn().mockResolvedValue({
      items: [session('s-4')],
      total: 1,
    } as GuessHistoryResponse);
    const toAnalysis = vi.fn().mockRejectedValue(new Error('500'));
    // silence console.warn в тесте
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderWithProviders(
      <GuessHistoryList fetcher={fetcher} toAnalysis={toAnalysis} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-history-link-s-4')).toBeInTheDocument(),
    );
    const btn = screen.getByTestId(
      'guess-history-link-s-4',
    ) as HTMLButtonElement;
    await user.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(mockNavigate).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
