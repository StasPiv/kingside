import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';

/**
 * KS-2447 v2: Live-таб — тонкая обёртка. При наличии ongoingRound
 * редиректит (`<Navigate replace>`) на страницу активного тура, где уже
 * работает 15s polling и обновление позиций. Без активного тура остаётся
 * plug «No round in progress». Локальный рендер досок и polling на
 * Live-табе УБРАН — дублирование логики недопустимо.
 *
 * Возврат с round-страницы через breadcrumb (`location.state.fromRound`)
 * НЕ должен повторно редиректить — иначе пользователь зацикливается.
 */

const broadcastApiMock = { get: vi.fn() };

vi.mock('../api/broadcastApi', () => ({
  broadcastApi: {
    get: (...a: unknown[]) => broadcastApiMock.get(...a),
  },
}));

vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { position?: string } }) => (
    <div data-testid="chessboard-mock" data-position={options.position ?? ''} />
  ),
}));

const locationStateRef: { current: unknown } = { current: null };
const navigateSpy = vi.fn<(args: { to: string; replace?: boolean }) => void>();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({ tournamentId: 'tx' }),
    useLocation: () => ({
      pathname: '/broadcasts/tx',
      search: '',
      hash: '',
      state: locationStateRef.current,
      key: 'mock',
    }),
    Navigate: ({ to, replace }: { to: string; replace?: boolean }) => {
      navigateSpy({ to, replace });
      return null;
    },
  };
});

import { BroadcastTournamentPage } from './BroadcastTournamentPage';

const META = {
  id: 'tx',
  lichessId: 'lx',
  title: 'TePe Sigeman',
  description: null,
  url: 'https://lichess.org/broadcast/tx',
  isActive: true,
  format: null,
  timeControl: null,
  location: null,
  players: null,
  website: null,
  standingsUrl: null,
  imageUrl: null,
  startDate: null,
  endDate: null,
  streams: null,
};

const ROUND = {
  id: 'r6',
  lichessRoundId: 'lr6',
  name: 'Round 6',
  startsAt: null,
  status: 'ongoing' as const,
};

beforeEach(() => {
  broadcastApiMock.get.mockReset();
  navigateSpy.mockReset();
  locationStateRef.current = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BroadcastTournamentPage KS-2447 v2 Live tab redirects to ongoing round', () => {
  it('Live-таб при наличии ongoingRound редиректит (Navigate replace) на /broadcasts/:tid/:rid', async () => {
    broadcastApiMock.get.mockImplementation((path: string) => {
      if (path === '/tx') return Promise.resolve(META);
      if (path === '/tx/rounds') return Promise.resolve({ data: [ROUND] });
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    const { container } = renderWithProviders(<BroadcastTournamentPage />, {
      route: '/broadcasts/tx',
    });

    // После того как rounds загрузятся, default activeTab станет 'live'
    // и Navigate отрендерится с правильным to.
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith({
        to: '/broadcasts/tx/r6',
        replace: true,
      });
    });

    // Локального рендера досок на Live-табе быть не должно.
    expect(container.querySelector('.broadcast-boards-grid')).toBeNull();
    // games-endpoint не должен вызываться — это работа round-страницы.
    const gamesCalls = broadcastApiMock.get.mock.calls.filter((c) =>
      String(c[0]).includes('/games'),
    );
    expect(gamesCalls.length).toBe(0);
  });

  it('Live-таб без ongoingRound показывает plug «Нет активного тура» и не редиректит', async () => {
    broadcastApiMock.get.mockImplementation((path: string) => {
      if (path === '/tx') return Promise.resolve(META);
      if (path === '/tx/rounds')
        return Promise.resolve({
          data: [{ ...ROUND, status: 'finished' }],
        });
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    renderWithProviders(<BroadcastTournamentPage />, { route: '/broadcasts/tx' });

    await waitFor(() =>
      expect(broadcastApiMock.get).toHaveBeenCalledWith('/tx/rounds'),
    );

    // Без ongoing default tab остаётся 'standings'. Переключаемся на Live.
    const liveTab = await screen.findByRole('button', { name: /Live/i });
    fireEvent.click(liveTab);

    // Никакого редиректа — Navigate не вызывался.
    expect(navigateSpy).not.toHaveBeenCalled();
    // games-endpoint не дёргается
    const gamesCalls = broadcastApiMock.get.mock.calls.filter((c) =>
      String(c[0]).includes('/games'),
    );
    expect(gamesCalls.length).toBe(0);
    // и есть plug-сообщение «No round in progress»
    expect(
      await screen.findByText(/No round in progress|Нет активного тура/i),
    ).toBeInTheDocument();
  });

  it('Возврат с round-страницы (state.fromRound=true) НЕ редиректит на тур', async () => {
    locationStateRef.current = { fromRound: true };
    broadcastApiMock.get.mockImplementation((path: string) => {
      if (path === '/tx') return Promise.resolve(META);
      if (path === '/tx/rounds') return Promise.resolve({ data: [ROUND] });
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    renderWithProviders(<BroadcastTournamentPage />, { route: '/broadcasts/tx' });

    await waitFor(() =>
      expect(broadcastApiMock.get).toHaveBeenCalledWith('/tx/rounds'),
    );
    // Дадим эффектам отработать.
    await new Promise((r) => setTimeout(r, 0));

    // Default tab остался 'standings' — Navigate не вызывался.
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
