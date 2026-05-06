import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { BroadcastsPage } from './BroadcastsPage';

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
  topPlayers: { name: string; elo: number }[];
};

function makeBroadcast(overrides: Partial<BroadcastFixture> & Pick<BroadcastFixture, 'id' | 'title' | 'lifecycleStatus'>): BroadcastFixture {
  return {
    lichessId: `lichess-${overrides.id}`,
    status: overrides.lifecycleStatus === 'finished' ? 'finished' : 'active',
    startDate: null,
    roundCount: 0,
    isPinned: false,
    avgElo: null,
    topPlayers: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockBroadcastApi.get.mockReset();
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

  // KS-2445: сортировка по среднему Elo desc внутри каждой секции,
  // null/undefined avgElo уезжают в конец секции.
  it('сортирует карточки по avgElo desc внутри каждой секции, без рейтинга — в конец', async () => {
    const data: BroadcastFixture[] = [
      makeBroadcast({ id: 'l-low', title: 'Live low', lifecycleStatus: 'live', avgElo: 2200 }),
      makeBroadcast({ id: 'l-null', title: 'Live no rating', lifecycleStatus: 'live', avgElo: null }),
      makeBroadcast({ id: 'l-high', title: 'Live high', lifecycleStatus: 'live', avgElo: 2800 }),
      makeBroadcast({ id: 'l-mid', title: 'Live mid', lifecycleStatus: 'live', avgElo: 2500 }),
      makeBroadcast({ id: 'u-low', title: 'Upcoming low', lifecycleStatus: 'upcoming', avgElo: 2100 }),
      makeBroadcast({ id: 'u-high', title: 'Upcoming high', lifecycleStatus: 'upcoming', avgElo: 2600 }),
    ];
    mockBroadcastApi.get.mockResolvedValueOnce({ data, total: data.length, limit: 100, offset: 0 });

    renderWithProviders(<BroadcastsPage />, { route: '/broadcasts' });

    await waitFor(() => expect(screen.getByTestId('broadcasts-live')).toBeInTheDocument());

    const liveTitles = Array.from(
      screen.getByTestId('broadcasts-live').querySelectorAll('.broadcast-lichess-title')
    ).map((el) => el.textContent);
    expect(liveTitles).toEqual(['Live high', 'Live mid', 'Live low', 'Live no rating']);

    const upcomingTitles = Array.from(
      screen.getByTestId('broadcasts-upcoming').querySelectorAll('.broadcast-lichess-title')
    ).map((el) => el.textContent);
    expect(upcomingTitles).toEqual(['Upcoming high', 'Upcoming low']);
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

/**
 * KS-2449: subtle-строка с фамилиями топ-N рейтинг-фаворитов под title
 * карточки. Берём `topPlayers` из API; имена в формате "Surname, First" —
 * рендерим только фамилии через запятую. Пустой массив → строка скрыта.
 */
describe('BroadcastsPage KS-2449 top players line', () => {
  it('рендерит фамилии топ-фаворитов из topPlayers под title (live и featured карточки)', async () => {
    const data: BroadcastFixture[] = [
      makeBroadcast({
        id: 'f1',
        title: 'Pinned Live',
        lifecycleStatus: 'live',
        isPinned: true,
        avgElo: 2700,
        topPlayers: [
          { name: 'Carlsen, Magnus', elo: 2840 },
          { name: 'Nakamura, Hikaru', elo: 2790 },
          { name: 'Gukesh, Dommaraju', elo: 2770 },
        ],
      }),
      makeBroadcast({
        id: 'l1',
        title: 'Live A',
        lifecycleStatus: 'live',
        topPlayers: [
          { name: 'Erdogmus, Yagiz Kaan', elo: 2520 },
          { name: 'Van Foreest, Jorden', elo: 2700 },
        ],
      }),
    ];
    mockBroadcastApi.get.mockResolvedValueOnce({ data, total: data.length, limit: 100, offset: 0 });

    renderWithProviders(<BroadcastsPage />, { route: '/broadcasts' });

    await waitFor(() => expect(screen.getByTestId('broadcasts-featured')).toBeInTheDocument());

    // Featured: фамилии видны под title (только фамилии, в порядке от backend).
    const featured = screen.getByTestId('broadcasts-featured');
    expect(featured.querySelector('[data-testid="broadcast-top-players"]')?.textContent).toBe(
      'Carlsen, Nakamura, Gukesh',
    );

    // Live: для l1 две фамилии, видны как есть.
    const live = screen.getByTestId('broadcasts-live');
    expect(
      live.querySelector('[data-testid="broadcast-top-players"]')?.textContent,
    ).toBe('Erdogmus, Van Foreest');
  });

  it('если topPlayers пустой или отсутствует — строка скрыта (не рендерится placeholder)', async () => {
    const data: BroadcastFixture[] = [
      makeBroadcast({
        id: 'l-empty',
        title: 'No players',
        lifecycleStatus: 'live',
        topPlayers: [],
      }),
    ];
    mockBroadcastApi.get.mockResolvedValueOnce({ data, total: 1, limit: 100, offset: 0 });

    renderWithProviders(<BroadcastsPage />, { route: '/broadcasts' });
    await waitFor(() => expect(screen.getByTestId('broadcasts-live')).toBeInTheDocument());

    expect(
      screen.queryByTestId('broadcast-top-players'),
    ).toBeNull();
  });

  it('если игрок один — показываем одного', async () => {
    const data: BroadcastFixture[] = [
      makeBroadcast({
        id: 'l-one',
        title: 'Single',
        lifecycleStatus: 'live',
        topPlayers: [{ name: 'Solo, Player', elo: 2500 }],
      }),
    ];
    mockBroadcastApi.get.mockResolvedValueOnce({ data, total: 1, limit: 100, offset: 0 });

    renderWithProviders(<BroadcastsPage />, { route: '/broadcasts' });
    await waitFor(() => expect(screen.getByTestId('broadcasts-live')).toBeInTheDocument());

    expect(screen.getByTestId('broadcast-top-players').textContent).toBe('Solo');
  });
});
