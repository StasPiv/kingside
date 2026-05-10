import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { PrecisionAttemptsListResponse } from '@kingside/shared';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { PrecisionAttemptsList } from './PrecisionAttemptsList';

/**
 * KS-2724 — список попыток в /precision.
 * Через DI `fetcher` мокаем endpoint без global api.
 */

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return { ...actual, useNavigate: () => navigateMock };
});

// Chessboard в jsdom тяжёл и не нужен — рендерим пустой div вместо него.
vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { position: string } }) => (
    <div data-testid="chessboard-mock" data-fen={options.position} />
  ),
}));

function makeItem(
  id: string,
  solved: boolean,
  overrides: Partial<{
    accuracyPercent: number;
    halfMovesPlayed: number;
    classCounts: { best: number; good: number; inaccuracy: number; mistake: number; blunder: number };
    endReason: string;
    attemptedAt: string;
  }> = {},
): PrecisionAttemptsListResponse['items'][number] {
  return {
    attemptId: id,
    puzzleId: `p-${id}`,
    puzzleFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    attemptedAt: overrides.attemptedAt ?? '2026-05-10T12:00:00Z',
    solved,
    endReason: overrides.endReason ?? (solved ? 'win' : 'lose-wdl'),
    halfMovesPlayed: overrides.halfMovesPlayed ?? 6,
    accuracyPercent: overrides.accuracyPercent ?? 80,
    classCounts: overrides.classCounts ?? {
      best: 3,
      good: 1,
      inaccuracy: 1,
      mistake: 1,
      blunder: 0,
    },
  };
}

describe('<PrecisionAttemptsList>', () => {
  beforeEach(() => {
    navigateMock.mockReset();
  });

  it('рендерит 3 попытки с разными endReason', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [
        makeItem('a1', true, { endReason: 'win' }),
        makeItem('a2', false, { endReason: 'lose-wdl' }),
        makeItem('a3', false, { endReason: 'lose-mate' }),
      ],
      total: 3,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.queryByTestId('precision-attempts')).toBeTruthy();
    });

    expect(
      screen.getByTestId('precision-attempts').getAttribute('data-state'),
    ).toBe('ready');
    expect(screen.getByTestId('precision-attempts-row-a1')).toBeTruthy();
    expect(screen.getByTestId('precision-attempts-row-a2')).toBeTruthy();
    expect(screen.getByTestId('precision-attempts-row-a3')).toBeTruthy();
    expect(
      screen.getByTestId('precision-attempts-row-a1').getAttribute('data-solved'),
    ).toBe('true');
    expect(
      screen.getByTestId('precision-attempts-row-a2').getAttribute('data-solved'),
    ).toBe('false');
  });

  it('клик по строке вызывает navigate("/precision/attempts/<id>")', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [makeItem('att-42', true)],
      total: 1,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    const link = await waitFor(() =>
      screen.getByTestId('precision-attempts-link-att-42'),
    );
    fireEvent.click(link);

    expect(navigateMock).toHaveBeenCalledWith('/precision/attempts/att-42');
  });

  it('пустой ответ → empty-state', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-attempts').getAttribute('data-state'),
      ).toBe('empty');
    });
    expect(screen.getByTestId('precision-attempts-empty')).toBeTruthy();
  });

  it('ошибка fetch → error-state с retry', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('500'));

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-attempts').getAttribute('data-state'),
      ).toBe('error');
    });
    expect(screen.getByTestId('precision-attempts-retry')).toBeTruthy();
  });

  it('фильтр Preserved оставляет только solved=true', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [
        makeItem('a1', true),
        makeItem('a2', false),
        makeItem('a3', true),
      ],
      total: 3,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.queryByTestId('precision-attempts-row-a1')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('precision-attempts-filter-preserved'));

    expect(screen.queryByTestId('precision-attempts-row-a1')).toBeTruthy();
    expect(screen.queryByTestId('precision-attempts-row-a2')).toBeNull();
    expect(screen.queryByTestId('precision-attempts-row-a3')).toBeTruthy();
  });

  it('items.length < total → показывает «Загрузить ещё»', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [makeItem('a1', true)],
      total: 5,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.getByTestId('precision-attempts-load-more')).toBeTruthy();
    });
  });

  it('items.length === total → «Загрузить ещё» не рендерится', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [makeItem('a1', true)],
      total: 1,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.queryByTestId('precision-attempts-row-a1')).toBeTruthy();
    });
    expect(screen.queryByTestId('precision-attempts-load-more')).toBeNull();
  });
});
