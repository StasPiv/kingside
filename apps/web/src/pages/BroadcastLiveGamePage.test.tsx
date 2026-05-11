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

// Controlled useParams: tests assign `routerParams.gameId` before render
// to verify both happy path и invalid-id guard (KS-2774).
const routerParams: {
  tournamentId: string;
  roundId: string;
  gameId: string;
} = {
  tournamentId: '00e9a4d0-4844-4b07-a113-ea0d8f49cf7a',
  roundId: '8343a66a-bb90-4e78-ba9a-93a93ca7cff9',
  gameId: 'bbd9e9c7-0f4f-4261-86f1-847f57d64cd1',
};
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => routerParams,
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

const TID = '00e9a4d0-4844-4b07-a113-ea0d8f49cf7a';
const RID = '8343a66a-bb90-4e78-ba9a-93a93ca7cff9';
const G1 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const G2 = 'bbd9e9c7-0f4f-4261-86f1-847f57d64cd1';
const G3 = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';

beforeEach(() => {
  broadcastApiMock.get.mockReset();
  socketState.captured = null;
  socketState.connected = false;
  // Reset router params to happy-path values.
  routerParams.tournamentId = TID;
  routerParams.roundId = RID;
  routerParams.gameId = G2;

  // Initial fetch: meta + rounds + games. gameId=G2 будет на index=1.
  broadcastApiMock.get.mockImplementation((path: string) => {
    if (path === `/${TID}`) return Promise.resolve({ id: TID, title: 'T' });
    if (path === `/${TID}/rounds`)
      return Promise.resolve({
        data: [{ id: RID, name: 'R1', status: 'ongoing' }],
      });
    if (path === `/${TID}/rounds/${RID}/games`)
      return Promise.resolve({
        data: [
          makeGame(G1, 'A', 'B'),
          makeGame(G2, 'C', 'D'),
          makeGame(G3, 'E', 'F'),
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
    expect(socketState.captured?.roundId).toBe(RID);
  });

  it('broadcast:move с нашим id → обновляет currentFen', async () => {
    renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      expect(screen.queryByTestId('chessboard-mock')).toBeTruthy();
    });
    const newFen = '8/8/8/4k3/4K3/8/8/8 w - - 0 50';
    socketState.captured?.onMove?.({
      roundId: RID,
      id: G2,
      gameIndex: 0,
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

  it('broadcast:move с чужим id игнорируется', async () => {
    renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      expect(screen.queryByTestId('chessboard-mock')).toBeTruthy();
    });
    const before = screen
      .getByTestId('chessboard-mock')
      .getAttribute('data-position');
    socketState.captured?.onMove?.({
      roundId: RID,
      id: G1,
      gameIndex: 0,
      uci: 'e2e4',
      fen: 'foreign-fen-should-be-ignored',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      screen
        .getByTestId('chessboard-mock')
        .getAttribute('data-position'),
    ).toBe(before);
  });

  it('broadcast:sync с нашим id обновляет currentFen', async () => {
    renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      expect(screen.queryByTestId('chessboard-mock')).toBeTruthy();
    });
    // chess.js нормализует en-passant поле в `-` если ход недоступен.
    const syncFen =
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    socketState.captured?.onSync?.({
      games: [
        {
          id: G1,
          whitePlayer: 'A',
          blackPlayer: 'B',
          pgn: '1. e4',
          currentFen: 'fen-A',
        } as unknown as BroadcastGameSummary,
        {
          id: G2,
          whitePlayer: 'C',
          blackPlayer: 'D',
          pgn: '1. e4',
          currentFen: syncFen,
        } as unknown as BroadcastGameSummary,
      ],
    });
    await waitFor(() => {
      expect(
        screen
          .getByTestId('chessboard-mock')
          .getAttribute('data-position'),
      ).toBe(syncFen);
    });
  });

  it('broadcast:sync с пустым games не валит state', async () => {
    renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      expect(screen.queryByTestId('chessboard-mock')).toBeTruthy();
    });
    const before = screen
      .getByTestId('chessboard-mock')
      .getAttribute('data-position');
    socketState.captured?.onSync?.({ games: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('chessboard-mock')).toBeTruthy();
    expect(
      screen
        .getByTestId('chessboard-mock')
        .getAttribute('data-position'),
    ).toBe(before);
  });

  it('broadcast:sync без нашего id (partial) не валит state', async () => {
    renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      expect(screen.queryByTestId('chessboard-mock')).toBeTruthy();
    });
    const before = screen
      .getByTestId('chessboard-mock')
      .getAttribute('data-position');
    socketState.captured?.onSync?.({
      games: [
        {
          id: G1,
          whitePlayer: 'A',
          blackPlayer: 'B',
          pgn: '',
          currentFen: 'foreign',
        } as unknown as BroadcastGameSummary,
      ],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('chessboard-mock')).toBeTruthy();
    expect(
      screen
        .getByTestId('chessboard-mock')
        .getAttribute('data-position'),
    ).toBe(before);
  });

  it('KS-2774: gameId="undefined" в URL → error без запросов к backend', async () => {
    routerParams.gameId = 'undefined';
    renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      // Должно отрисоваться сообщение «not found».
      expect(document.querySelector('.error')).toBeTruthy();
    });
    // Backend НЕ должен быть дёрнут с мусорным gameId.
    expect(broadcastApiMock.get).not.toHaveBeenCalled();
  });

  it('KS-2774: gameId не UUID → error без запросов', async () => {
    routerParams.gameId = 'not-a-uuid';
    renderWithProviders(<BroadcastLiveGamePage />);
    await waitFor(() => {
      expect(document.querySelector('.error')).toBeTruthy();
    });
    expect(broadcastApiMock.get).not.toHaveBeenCalled();
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
