/**
 * KS-2772: тесты live-страницы партии трансляции.
 *
 * Проверяем:
 *  1. При mount хук `useBroadcastSocket` получает `roundId` из URL —
 *     значит подписка идёт по `{ roundId }` (а не по `gameId`, как
 *     был баг до фикса; backend такие сообщения молча игнорирует).
 *  2. Входящий `broadcast:move` с правильным `gameIndex` обновляет
 *     `currentFen` доски.
 *  3. Входящий `broadcast:move` с ЧУЖИМ `gameIndex` игнорируется.
 *  4. LIVE-pill отражает реальный статус подключения:
 *     - `connected=true` → «LIVE…», `data-connected="true"`.
 *     - `connected=false` → «Переподключение…», `data-connected="false"`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BroadcastGameSummary } from '@kingside/shared';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';

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

vi.mock('../hooks/useSounds', () => ({
  useSounds: () => ({
    playSound: vi.fn(),
    unlocked: true,
    unlockSounds: vi.fn(),
  }),
  soundEventFromSan: () => 'move',
}));

vi.mock('../hooks/useBroadcastClock', () => ({
  formatBroadcastClock: () => null,
  useBroadcastClock: () => ({
    whiteRemainingMs: null,
    blackRemainingMs: null,
    hasClocks: false,
  }),
}));

// Перехват `useBroadcastSocket`: сохраняем переданные callbacks +
// возвращаем управляемый `connected`.
type Captured = {
  roundId: string | null | undefined;
  onSync?: (p: unknown) => void;
  onMove?: (p: unknown) => void;
};
const socketState: { captured: Captured | null; connected: boolean } = {
  captured: null,
  connected: false,
};
vi.mock('../hooks/useBroadcastSocket', () => ({
  useBroadcastSocket: (args: Captured) => {
    socketState.captured = args;
    return { connected: socketState.connected };
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({
      tournamentId: 't1',
      roundId: 'r1',
      gameId: 'g2',
    }),
    useNavigate: () => vi.fn(),
  };
});

import { BroadcastLiveGamePage } from './BroadcastLiveGamePage';

function makeGame(
  id: string,
  whitePlayer: string,
  blackPlayer: string,
): BroadcastGameSummary {
  return {
    id,
    lichessGameId: null,
    whitePlayer,
    blackPlayer,
    whiteElo: null,
    blackElo: null,
    result: '*',
    pgn: '',
    currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    updatedAt: '2026-05-11T00:00:00.000Z',
    bracketStage: null,
    bracketPairId: null,
    matchScore: null,
  };
}

beforeEach(() => {
  broadcastApiMock.get.mockReset();
  socketState.captured = null;
  socketState.connected = false;

  // Initial fetch: meta + rounds + games. gameId='g2' будет на index=1.
  broadcastApiMock.get.mockImplementation((path: string) => {
    if (path === '/t1') return Promise.resolve({ id: 't1', title: 'T' });
    if (path === '/t1/rounds')
      return Promise.resolve({
        data: [{ id: 'r1', name: 'R1', status: 'ongoing' }],
      });
    if (path === '/t1/rounds/r1/games')
      return Promise.resolve({
        data: [
          makeGame('g1', 'A', 'B'),
          makeGame('g2', 'C', 'D'),
          makeGame('g3', 'E', 'F'),
        ],
      });
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<BroadcastLiveGamePage> KS-2772', () => {
  it('subscribe идёт по roundId (а не по gameId)', async () => {
    renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      expect(screen.queryByTestId('chessboard-mock')).toBeTruthy();
    });
    // useBroadcastSocket получил `roundId` из URL params.
    expect(socketState.captured?.roundId).toBe('r1');
  });

  it('broadcast:move с правильным gameIndex обновляет currentFen', async () => {
    renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      expect(screen.queryByTestId('chessboard-mock')).toBeTruthy();
    });
    // gameId='g2' → index=1.
    const newFen = '8/8/8/4k3/4K3/8/8/8 w - - 0 50';
    socketState.captured?.onMove?.({
      roundId: 'r1',
      gameIndex: 1,
      uci: 'e2e4',
      fen: newFen,
    });
    await waitFor(() => {
      expect(
        screen
          .getByTestId('chessboard-mock')
          .getAttribute('data-position'),
      ).toBe(newFen);
    });
  });

  it('broadcast:move с чужим gameIndex игнорируется', async () => {
    renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      expect(screen.queryByTestId('chessboard-mock')).toBeTruthy();
    });
    const before = screen
      .getByTestId('chessboard-mock')
      .getAttribute('data-position');
    socketState.captured?.onMove?.({
      roundId: 'r1',
      gameIndex: 0, // чужой
      uci: 'e2e4',
      fen: 'foreign-fen-should-be-ignored',
    });
    // Спустя короткое время позиция НЕ должна поменяться.
    await new Promise((r) => setTimeout(r, 50));
    expect(
      screen
        .getByTestId('chessboard-mock')
        .getAttribute('data-position'),
    ).toBe(before);
  });

  it('LIVE-pill: connected=true → «LIVE…», connected=false → «Переподключение…»', async () => {
    socketState.connected = true;
    const { unmount } = renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      const pill = screen.queryByTestId('broadcast-live-pill');
      if (!pill) throw new Error('pill not rendered yet');
    });
    const pill = screen.getByTestId('broadcast-live-pill');
    expect(pill.getAttribute('data-connected')).toBe('true');
    expect(pill.textContent).toMatch(/LIVE/i);
    unmount();

    socketState.connected = false;
    renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      expect(screen.queryByTestId('broadcast-live-pill')).toBeTruthy();
    });
    const pill2 = screen.getByTestId('broadcast-live-pill');
    expect(pill2.getAttribute('data-connected')).toBe('false');
    expect(pill2.textContent).toMatch(/Reconnect|Переподключение/i);
  });
});
