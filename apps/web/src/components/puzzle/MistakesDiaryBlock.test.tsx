import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UserMistakeAggregate } from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { MistakesDiaryBlock } from './MistakesDiaryBlock';

/**
 * KS-1928: full-блок «Слабые темы» на /puzzles/stats.
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
      <Route path="/" element={<MistakesDiaryBlock />} />
    </Routes>,
    { route: '/' },
  );
}

beforeEach(() => {
  apiMock.getAggregates.mockReset();
  apiMock.getRecommendations.mockReset();
  authMock.user = { id: 'me', username: 'me' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<MistakesDiaryBlock> — full', () => {
  it('гость → блок не рендерится', () => {
    authMock.user = null;
    renderRouter();
    expect(apiMock.getAggregates).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mistakes-diary-block')).not.toBeInTheDocument();
  });

  it('пустой список → блок не рендерится', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [],
      totalThemes: 0,
      since: null,
      limit: 5,
    });
    renderRouter();
    await waitFor(() => expect(apiMock.getAggregates).toHaveBeenCalled());
    expect(screen.queryByTestId('mistakes-diary-block')).not.toBeInTheDocument();
  });

  it('error → блок не рендерится (тихо)', async () => {
    apiMock.getAggregates.mockRejectedValueOnce(new Error('boom'));
    renderRouter();
    await waitFor(() => expect(apiMock.getAggregates).toHaveBeenCalled());
    expect(screen.queryByTestId('mistakes-diary-block')).not.toBeInTheDocument();
  });

  it('рендерит топ-5 + CTA с правильным URL puzzles namespace', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [agg({ theme: 'fork', count: 10 })],
      totalThemes: 1,
      since: null,
      limit: 5,
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-diary-block')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mistakes-diary-cta-fork')).toHaveAttribute(
      'href',
      '/puzzles/mistakes-practice?theme=fork',
    );
  });

  it('обрезает список до 5 + «Смотреть всё» → /puzzles/mistakes', async () => {
    const items: UserMistakeAggregate[] = [
      agg({ theme: 'fork', count: 10 }),
      agg({ theme: 'pin', count: 8 }),
      agg({ theme: 'skewer', count: 6 }),
      agg({ theme: 'mate', count: 5 }),
      agg({ theme: 'sacrifice', count: 4 }),
      agg({ theme: 'endgame', count: 2 }),
    ];
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: items,
      totalThemes: 6,
      since: null,
      limit: 5,
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-diary-block')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mistakes-diary-item-fork')).toBeInTheDocument();
    expect(screen.getByTestId('mistakes-diary-item-sacrifice')).toBeInTheDocument();
    expect(
      screen.queryByTestId('mistakes-diary-item-endgame'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('mistakes-diary-see-all')).toHaveAttribute(
      'href',
      '/puzzles/mistakes',
    );
  });

  it('«Смотреть всё» скрыто, когда totalThemes ≤ показанных', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [agg({ theme: 'fork' }), agg({ theme: 'pin' })],
      totalThemes: 2,
      since: null,
      limit: 5,
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-diary-block')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('mistakes-diary-see-all')).not.toBeInTheDocument();
  });

  it('счётчик тем использует totalThemes', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [agg({ theme: 'fork' })],
      totalThemes: 15,
      since: null,
      limit: 5,
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-diary-total')).toHaveTextContent('15'),
    );
  });

  it('URL-encoding в theme (безопасность)', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [
        agg({ theme: 'fork&mate' as UserMistakeAggregate['theme'], count: 3 }),
      ],
      totalThemes: 1,
      since: null,
      limit: 5,
    });
    renderRouter();
    await waitFor(() =>
      expect(
        screen.getByTestId('mistakes-diary-cta-fork&mate'),
      ).toHaveAttribute(
        'href',
        '/puzzles/mistakes-practice?theme=fork%26mate',
      ),
    );
  });

  it('запрашивает getAggregates с limit=5', async () => {
    apiMock.getAggregates.mockResolvedValueOnce({
      aggregates: [agg({ theme: 'fork' })],
      totalThemes: 1,
      since: null,
      limit: 5,
    });
    renderRouter();
    await waitFor(() => expect(apiMock.getAggregates).toHaveBeenCalled());
    expect(apiMock.getAggregates).toHaveBeenCalledWith({ limit: 5 });
  });
});
