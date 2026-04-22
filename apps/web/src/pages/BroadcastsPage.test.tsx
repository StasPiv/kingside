import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { BroadcastsPage } from './BroadcastsPage';

const mockApi = { get: vi.fn() };
vi.mock('../api', () => ({
  api: {
    get: (...args: unknown[]) => mockApi.get(...args),
  },
}));

const mockBroadcastApi = { get: vi.fn() };
vi.mock('../api/broadcastApi', () => ({
  broadcastApi: {
    get: (...args: unknown[]) => mockBroadcastApi.get(...args),
  },
}));

vi.mock('../components/HelpButton', () => ({
  HelpButton: () => <span data-testid="help" />,
}));

type BroadcastFixture = {
  id: string;
  lichessId: string;
  title: string;
  status: 'active' | 'finished';
  lifecycleStatus: 'live' | 'upcoming' | 'finished';
  startDate: string | null;
  roundCount: number;
  isPinned: boolean;
  avgElo: number | null;
};

function makeBroadcast(overrides: Partial<BroadcastFixture> & Pick<BroadcastFixture, 'id' | 'title' | 'lifecycleStatus'>): BroadcastFixture {
  return {
    lichessId: `lichess-${overrides.id}`,
    status: overrides.lifecycleStatus === 'finished' ? 'finished' : 'active',
    startDate: null,
    roundCount: 0,
    isPinned: false,
    avgElo: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockApi.get.mockReset();
  mockBroadcastApi.get.mockReset();
  // DGT /tournaments/live — пустой ответ, чтобы не мешать
  mockApi.get.mockImplementation(() =>
    Promise.resolve({ data: [] }),
  );
});

/**
 * KS-1700 Part C: секции Live/Upcoming/Finished на странице /broadcasts.
 */
describe('BroadcastsPage KS-1700 sections', () => {
  it('рендерит секции Featured, Live, Upcoming, Finished и бейджи соответствующие lifecycleStatus', async () => {
    const data: BroadcastFixture[] = [
      makeBroadcast({ id: 'f1', title: 'Featured pinned', lifecycleStatus: 'live', isPinned: true, avgElo: 2700 }),
      makeBroadcast({ id: 'l1', title: 'Live A', lifecycleStatus: 'live' }),
      makeBroadcast({ id: 'l2', title: 'Live B', lifecycleStatus: 'live' }),
      makeBroadcast({ id: 'u1', title: 'Upcoming A', lifecycleStatus: 'upcoming' }),
      makeBroadcast({ id: 'd1', title: 'Done A', lifecycleStatus: 'finished' }),
    ];
    mockBroadcastApi.get.mockResolvedValueOnce({ data, total: data.length, limit: 100, offset: 0 });

    renderWithProviders(<BroadcastsPage />, { route: '/broadcasts' });

    await waitFor(() => expect(screen.getByTestId('broadcasts-featured')).toBeInTheDocument());

    // Featured содержит pinned live
    const featured = screen.getByTestId('broadcasts-featured');
    expect(featured).toHaveTextContent('Featured pinned');
    expect(featured).toHaveTextContent('LIVE');

    // Live — остальные live
    const live = screen.getByTestId('broadcasts-live');
    expect(live).toHaveTextContent('Live A');
    expect(live).toHaveTextContent('Live B');
    expect(live).not.toHaveTextContent('Featured pinned'); // pinned идут в featured
    // Бейджи LIVE в секции live (по одному на каждой карточке)
    expect(live.querySelectorAll('.broadcast-lichess-status--live').length).toBe(2);

    // Upcoming
    const upcoming = screen.getByTestId('broadcasts-upcoming');
    expect(upcoming).toHaveTextContent('Upcoming A');
    expect(upcoming).toHaveTextContent('UPCOMING');
    expect(upcoming.querySelectorAll('.broadcast-lichess-status--upcoming').length).toBe(1);

    // Finished (свёрнут по умолчанию, показан только заголовок + счётчик)
    const finished = screen.getByTestId('broadcasts-finished');
    expect(finished).toHaveTextContent('Finished');
    expect(finished).toHaveTextContent('(1)');
    expect(screen.queryByTestId('broadcasts-finished-grid')).toBeNull();
    // После клика разворачивается
    fireEvent.click(finished.querySelector('.broadcasts-finished-toggle')!);
    expect(screen.getByTestId('broadcasts-finished-grid')).toHaveTextContent('Done A');
    expect(screen.getByTestId('broadcasts-finished-grid').querySelectorAll('.broadcast-lichess-status--finished').length).toBe(1);
  });

  it('не рендерит пустые секции', async () => {
    const data: BroadcastFixture[] = [
      makeBroadcast({ id: 'l1', title: 'Live only', lifecycleStatus: 'live' }),
    ];
    mockBroadcastApi.get.mockResolvedValueOnce({ data, total: 1, limit: 100, offset: 0 });

    renderWithProviders(<BroadcastsPage />, { route: '/broadcasts' });

    await waitFor(() => expect(screen.getByTestId('broadcasts-live')).toBeInTheDocument());

    expect(screen.queryByTestId('broadcasts-featured')).toBeNull();
    expect(screen.queryByTestId('broadcasts-upcoming')).toBeNull();
    expect(screen.queryByTestId('broadcasts-finished')).toBeNull();
  });

  it('fallback: если lifecycleStatus отсутствует (старое API), isActive=true → live, иначе → finished', async () => {
    // Имитация ответа старого API без lifecycleStatus — Partial<BroadcastSummary>.
    const data = [
      { id: 'a', lichessId: 'a', title: 'Legacy active', isActive: true },
      { id: 'b', lichessId: 'b', title: 'Legacy inactive', isActive: false },
    ];
    mockBroadcastApi.get.mockResolvedValueOnce({ data, total: 2, limit: 100, offset: 0 });

    renderWithProviders(<BroadcastsPage />, { route: '/broadcasts' });

    await waitFor(() => expect(screen.getByTestId('broadcasts-live')).toBeInTheDocument());

    expect(screen.getByTestId('broadcasts-live')).toHaveTextContent('Legacy active');
    const finished = screen.getByTestId('broadcasts-finished');
    expect(finished).toHaveTextContent('(1)');
    fireEvent.click(finished.querySelector('.broadcasts-finished-toggle')!);
    expect(screen.getByTestId('broadcasts-finished-grid')).toHaveTextContent('Legacy inactive');
  });
});
