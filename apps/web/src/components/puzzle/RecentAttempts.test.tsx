/**
 * KS-2498 — тесты `<RecentAttempts>`. Проверяем поведение клика по
 * строке (всегда `/puzzle/:id`, для play-vs-engine с
 * `?source=play-vs-engine`) и наличие/отсутствие кнопки «Анализ»:
 *
 *  - forced-line: основная ссылка на `/puzzle/:id`, есть кнопка
 *    «Анализ» → ведёт на /analysis с собранным PGN.
 *  - play-vs-engine: основная ссылка на `/puzzle/:id?source=play-vs-engine`,
 *    кнопка «Анализ» НЕ рендерится.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { RecentAttempts, type RecentAttempt } from './RecentAttempts';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const apiGet = vi.fn();
vi.mock('../../api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
  },
}));

function build(attempt: Partial<RecentAttempt> = {}): RecentAttempt {
  return {
    id: 'att-1',
    puzzleId: 'puz-abcdef0123',
    solved: true,
    timeMs: 14000,
    ratingBefore: 1500,
    ratingAfter: 1512,
    createdAt: '2026-05-07T08:00:00Z',
    puzzle: {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      moves: 'e2e4',
      solutionMode: 'forced-line',
    },
    ...attempt,
  };
}

describe('<RecentAttempts> KS-2498', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    apiGet.mockReset();
  });

  it('forced-line: ссылка ведёт на /puzzle/:id и есть кнопка «Анализ»', () => {
    const a = build({ id: 'att-fl', puzzleId: 'puz-forced-1' });
    renderWithProviders(<RecentAttempts attempts={[a]} />);

    const link = screen.getByTestId('recent-attempts-link-att-fl');
    expect(link.getAttribute('href')).toBe('/puzzle/puz-forced-1');

    const row = screen.getByTestId('recent-attempts-row-att-fl');
    expect(row.getAttribute('data-mode')).toBe('forced-line');

    expect(
      screen.getByTestId('recent-attempts-analyze-att-fl'),
    ).toBeInTheDocument();
  });

  it('KS-2547: play-vs-engine attempt → /puzzle/:id?source=precision и кнопки «Анализ» НЕТ', () => {
    const a = build({
      id: 'att-pve',
      puzzleId: 'puz-pve-1',
      puzzle: {
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: '',
        solutionMode: 'play-vs-engine',
      },
    });
    renderWithProviders(<RecentAttempts attempts={[a]} />);

    const link = screen.getByTestId('recent-attempts-link-att-pve');
    expect(link.getAttribute('href')).toBe(
      '/puzzle/puz-pve-1?source=precision',
    );

    const row = screen.getByTestId('recent-attempts-row-att-pve');
    expect(row.getAttribute('data-mode')).toBe('play-vs-engine');

    expect(
      screen.queryByTestId('recent-attempts-analyze-att-pve'),
    ).not.toBeInTheDocument();
  });

  it('старый клиент без solutionMode → дефолт forced-line: ссылка /puzzle/:id, есть «Анализ»', () => {
    const a = build({
      id: 'att-old',
      puzzleId: 'puz-old-1',
      puzzle: {
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: 'e2e4',
        // solutionMode отсутствует — старый api shape
      },
    });
    renderWithProviders(<RecentAttempts attempts={[a]} />);

    const link = screen.getByTestId('recent-attempts-link-att-old');
    expect(link.getAttribute('href')).toBe('/puzzle/puz-old-1');
    expect(
      screen.getByTestId('recent-attempts-analyze-att-old'),
    ).toBeInTheDocument();
  });

  it('клик «Анализ» (forced-line) фетчит puzzle и навигирует на /analysis с PGN', async () => {
    const a = build({ id: 'att-fl2', puzzleId: 'puz-forced-2' });
    apiGet.mockResolvedValueOnce({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      moves: 'e2e4 e7e5',
    });
    renderWithProviders(<RecentAttempts attempts={[a]} />);

    await userEvent.click(screen.getByTestId('recent-attempts-analyze-att-fl2'));

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith('/puzzles/puz-forced-2');
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        '/analysis',
        expect.objectContaining({
          state: expect.objectContaining({
            pgn: expect.stringContaining('[FEN'),
            title: expect.stringContaining('Puzzle #'),
          }),
        }),
      );
    });
  });

  it('пустой список → блок не рендерится', () => {
    const { container } = renderWithProviders(<RecentAttempts attempts={[]} />);
    expect(container.querySelector('[data-testid="recent-attempts"]')).toBeNull();
  });

  it('пагинация: при > 20 попытках видим «1 / N» и работает кнопка Next', async () => {
    const list: RecentAttempt[] = Array.from({ length: 25 }, (_, i) =>
      build({ id: `att-${i}`, puzzleId: `puz-${i}` }),
    );
    renderWithProviders(<RecentAttempts attempts={list} />);

    expect(screen.getByText(/1 \/ 2/)).toBeInTheDocument();
    expect(screen.getByTestId('recent-attempts-row-att-0')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-attempts-row-att-20')).toBeNull();

    await userEvent.click(screen.getByText(/Next|Next page|След/));
    expect(screen.getByText(/2 \/ 2/)).toBeInTheDocument();
    expect(screen.queryByTestId('recent-attempts-row-att-0')).toBeNull();
    expect(
      screen.getByTestId('recent-attempts-row-att-20'),
    ).toBeInTheDocument();
  });
});
