import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UserMistakeAggregate } from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { MistakesDiaryHint } from './MistakesDiaryHint';

/**
 * KS-1928: compact-вариант блока «Слабые темы» под доской на /puzzle.
 */

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: { getAggregates: vi.fn(), getRecommendations: vi.fn() },
  authMock: {
    user: { id: 'me', username: 'me' } as { id: string; username: string } | null,
  },
}));

vi.mock('../../api/puzzleMistakesApi', () => ({
  puzzleMistakesApi: apiMock,
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: authMock.user
      ? {
          ...authMock.user,
          email: 'm@x',
          ratingBullet: 1500,
          ratingBlitz: 1500,
          ratingRapid: 1500,
          ratingClassical: 1500,
          createdAt: '2026-01-01',
        }
      : null,
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function agg(partial: Partial<UserMistakeAggregate>): UserMistakeAggregate {
  return {
    theme: 'fork',
    count: 5,
    lastOccurredAt: '2026-04-22T00:00:00.000Z',
    ...partial,
  } as UserMistakeAggregate;
}

function renderRouter() {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<MistakesDiaryHint />} />
    </Routes>,
    { route: '/' },
  );
}

beforeEach(() => {
  apiMock.getAggregates.mockReset();
  authMock.user = { id: 'me', username: 'me' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<MistakesDiaryHint>', () => {
  it('гость → hint скрыт', () => {
    authMock.user = null;
    renderRouter();
    expect(apiMock.getAggregates).not.toHaveBeenCalled();
    expect(screen.queryByTestId('puzzle-mistakes-hint')).not.toBeInTheDocument();
  });

  it('пустой список → hint скрыт', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [],
      totalThemes: 0,
      since: null,
      limit: 3,
    });
    renderRouter();
    await waitFor(() => expect(apiMock.getAggregates).toHaveBeenCalled());
    expect(screen.queryByTestId('puzzle-mistakes-hint')).not.toBeInTheDocument();
  });

  it('error → hint скрыт', async () => {
    apiMock.getAggregates.mockRejectedValueOnce(new Error('boom'));
    renderRouter();
    await waitFor(() => expect(apiMock.getAggregates).toHaveBeenCalled());
    expect(screen.queryByTestId('puzzle-mistakes-hint')).not.toBeInTheDocument();
  });

  it('рендерит максимум 3 чипа с правильными URL', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [
        agg({ theme: 'pin', count: 12 }),
        agg({ theme: 'fork', count: 8 }),
        agg({ theme: 'mateIn1', count: 5 }),
        agg({ theme: 'sacrifice', count: 3 }),
      ],
      totalThemes: 4,
      since: null,
      limit: 3,
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-mistakes-hint')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('puzzle-mistakes-hint-chip-pin'),
    ).toHaveAttribute('href', '/puzzles/mistakes-practice?theme=pin');
    expect(
      screen.getByTestId('puzzle-mistakes-hint-chip-fork'),
    ).toHaveAttribute('href', '/puzzles/mistakes-practice?theme=fork');
    expect(
      screen.getByTestId('puzzle-mistakes-hint-chip-mateIn1'),
    ).toHaveAttribute('href', '/puzzles/mistakes-practice?theme=mateIn1');
    // 4-й не должен рендериться
    expect(
      screen.queryByTestId('puzzle-mistakes-hint-chip-sacrifice'),
    ).not.toBeInTheDocument();
  });

  it('счётчик в чипе показывает count', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [agg({ theme: 'pin', count: 12 })],
      totalThemes: 1,
      since: null,
      limit: 3,
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-mistakes-hint-chip-pin')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('puzzle-mistakes-hint-chip-pin'),
    ).toHaveTextContent('(12)');
  });

  it('запрашивает getAggregates с limit=3', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [agg({ theme: 'pin' })],
      totalThemes: 1,
      since: null,
      limit: 3,
    });
    renderRouter();
    await waitFor(() => expect(apiMock.getAggregates).toHaveBeenCalled());
    expect(apiMock.getAggregates).toHaveBeenCalledWith({ limit: 3 });
  });
});
