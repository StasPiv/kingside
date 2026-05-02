/**
 * Integration tests для `BotInstanceImpl`.
 *
 * Поднимает локально mock-WS-сервер на socket.io с двумя namespace'ами
 * (`/matchmaking` и `/game`), который имитирует контракт реального
 * `apps/game-service`. Поднимать сам game-service в jest-тесте слишком
 * дорого (Postgres, Stockfish, миграции) — для проверки контракта
 * BotInstance'а достаточно WS-сервера, отвечающего теми же событиями.
 *
 * Покрывает 5 сценариев из описания тикета:
 *   1. join → found → in_game.
 *   2. ход → ответный ход × 5.
 *   3. midgame disconnect → reconnect (1s) → продолжение.
 *   4. 5 fail подряд → failed.
 *   5. idempotent JOIN (ALREADY_IN_QUEUE).
 */
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server as IOServer, Socket as ServerSocket } from 'socket.io';
import { GameEvents, MatchmakingEvents } from '@kingside/shared';
import {
  BotInstanceImpl,
  type BotInstanceState,
  type TokenSource,
} from './bot-instance';
import { MockMoveEngine } from '../move-engine/move-engine.mock';

/* ===================== Mock WS Server ===================== */

interface MockServerHandle {
  http: HttpServer;
  io: IOServer;
  url: string;
  /** Принудительно разрывает все подключения от mock-сервера. */
  disconnectAll: () => void;
  /** Имитирует «ALREADY_IN_QUEUE» — следующий JOIN в /matchmaking → ERROR. */
  setAlreadyInQueueResponse: (on: boolean) => void;
  /**
   * Стартует партию по факту JOIN'а (gameId, color).
   * По умолчанию — `mock-game-1`, `white`.
   */
  configureMatchFound: (cfg: { gameId?: string; color?: 'white' | 'black' }) => void;
  /** Список UCI ходов соперника, которые server шлёт в ответ на наш move. */
  configureOpponentScript: (moves: string[]) => void;
  /** Возвращает массив UCI-ходов, которые BotInstance прислал в game:move. */
  receivedMoves: () => string[];
  receivedMatchmakingJoins: () => number;
  /** Закрывает сервер. */
  close: () => Promise<void>;
}

async function startMockServer(): Promise<MockServerHandle> {
  const http = createServer();
  const io = new IOServer(http, { cors: { origin: '*' } });

  let alreadyInQueue = false;
  let foundCfg: { gameId: string; color: 'white' | 'black' } = {
    gameId: 'mock-game-1',
    color: 'white',
  };
  let opponentScript: string[] = [];
  const receivedMoves: string[] = [];
  let mmJoinCount = 0;

  const mmNs = io.of('/matchmaking');
  mmNs.on('connection', (sock: ServerSocket) => {
    sock.on(MatchmakingEvents.JOIN, () => {
      mmJoinCount++;
      if (alreadyInQueue) {
        sock.emit(MatchmakingEvents.ERROR, {
          code: 'ALREADY_IN_QUEUE',
          message: 'already in queue',
        });
        return;
      }
      // Имитируем подбор: сразу шлём FOUND.
      setImmediate(() => {
        sock.emit(MatchmakingEvents.FOUND, {
          gameId: foundCfg.gameId,
          color: foundCfg.color,
          opponent: { id: 'opp-1', username: 'opp' },
          timeControl: 'bullet',
          timeInitial: 60,
          increment: 0,
        });
      });
    });
    sock.on(MatchmakingEvents.LEAVE, () => {
      // ничего, mock; реальный сервер тут чистит очередь
    });
  });

  const gameNs = io.of('/game');
  gameNs.on('connection', (sock: ServerSocket) => {
    sock.on(GameEvents.JOIN, (payload: { gameId: string }) => {
      // Шлём начальное состояние партии (стартовая позиция).
      sock.emit(GameEvents.STATE, {
        gameId: payload.gameId,
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: [],
        clocks: { whiteMs: 60_000, blackMs: 60_000 },
        status: 'active',
        color: foundCfg.color,
      });
    });

    sock.on(GameEvents.MOVE, (payload: { gameId: string; uci: string }) => {
      receivedMoves.push(payload.uci);
      // Подтверждаем наш ход (клиент должен обновить move-history).
      sock.emit(GameEvents.MOVE_SERVER, {
        uci: payload.uci,
        san: payload.uci,
        // Меняем сторону: после хода белых — ходят чёрные. Не вычисляем
        // реальный FEN, тесту не нужно — нужны только W/B сегменты.
        fen:
          parseFenTurn(payload.uci) === 'w'
            ? 'fen-after-white b - - - -'
            : 'fen-after-black w - - - -',
        clocks: { whiteMs: 60_000, blackMs: 60_000 },
      });

      // Если в скрипте есть ответ соперника — шлём его (с задержкой).
      // После хода соперника (чёрные) ходить белым — боту.
      const reply = opponentScript[receivedMoves.length - 1];
      if (reply) {
        setTimeout(() => {
          sock.emit(GameEvents.MOVE_SERVER, {
            uci: reply,
            san: reply,
            fen: 'fen-after-reply w - - - -',
            clocks: { whiteMs: 60_000, blackMs: 60_000 },
          });
        }, 5);
      }
    });

    sock.on(GameEvents.RESIGN, () => {
      sock.emit(GameEvents.END, { result: 'black-wins', termination: 'resign' });
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;

  return {
    http,
    io,
    url: `http://127.0.0.1:${port}`,
    disconnectAll: () => {
      io.disconnectSockets(true);
    },
    setAlreadyInQueueResponse: (on) => {
      alreadyInQueue = on;
    },
    configureMatchFound: (cfg) => {
      foundCfg = {
        gameId: cfg.gameId ?? foundCfg.gameId,
        color: cfg.color ?? foundCfg.color,
      };
    },
    configureOpponentScript: (m) => {
      opponentScript = m;
    },
    receivedMoves: () => receivedMoves.slice(),
    receivedMatchmakingJoins: () => mmJoinCount,
    close: () =>
      new Promise<void>((resolve) => {
        if (!http.listening) {
          // Сервер уже закрыли в самом тесте — повторный close() — no-op.
          return resolve();
        }
        io.close(() =>
          http.close(() => {
            resolve();
          }),
        );
      }),
  };
}

// FEN-сегмент после хода — нужен только тестам (для определения, чей ход).
// Имитация: если строка ходила чётным индексом — белые ходили, теперь чёрные.
function parseFenTurn(_uci: string): 'w' | 'b' {
  return 'w';
}

/* ===================== Helpers ===================== */

const fakeTokens: TokenSource = {
  async getToken() {
    return 'jwt-test-token';
  },
};

async function waitFor<T>(
  cond: () => T | undefined,
  timeoutMs: number,
  step = 25,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = cond();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`waitFor: timeout after ${timeoutMs}ms`);
}

/* ===================== Tests ===================== */

describe('BotInstanceImpl — integration with mock WS server', () => {
  let server: MockServerHandle;

  beforeEach(async () => {
    server = await startMockServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('Тест 1: connect → JOIN → FOUND → in_game', async () => {
    server.configureMatchFound({ gameId: 'g-1', color: 'white' });

    const bot = new BotInstanceImpl('bot-1', 'TestBot', {
      tokens: fakeTokens,
      engine: new MockMoveEngine([], 0),
      gameServiceUrl: server.url,
      profile: { skill: 1, defaultThinkMs: 0 },
      disableJoinJitter: true,
      shutdownTimeoutMs: 200,
    });

    await bot.connect('bullet', { timeInitial: 60, increment: 0 });

    await waitFor(() => bot.state === 'in_game', 3_000);
    expect(bot.currentGameId).toBe('g-1');

    await bot.shutdown();
  });

  it('Тест 2: 5 ходов с заскриптованным соперником', async () => {
    // Бот играет белыми. Скрипт соперника — 5 чёрных ходов.
    server.configureMatchFound({ gameId: 'g-2', color: 'white' });
    server.configureOpponentScript(['e7e5', 'e7e6', 'e7e7', 'e7e8', 'e7e9']);

    const botMoves = ['e2e4', 'e2e3', 'e2e2', 'e2e1', 'e2e0'];
    const bot = new BotInstanceImpl('bot-2', 'TestBot', {
      tokens: fakeTokens,
      engine: new MockMoveEngine(botMoves, 0),
      gameServiceUrl: server.url,
      profile: { skill: 1, defaultThinkMs: 0 },
      disableJoinJitter: true,
      shutdownTimeoutMs: 200,
    });

    await bot.connect('bullet', { timeInitial: 60, increment: 0 });
    await waitFor(() => bot.state === 'in_game', 2_000);

    await waitFor(() => server.receivedMoves().length >= 5, 4_000);
    expect(server.receivedMoves().slice(0, 5)).toEqual(botMoves);

    await bot.shutdown();
  });

  it('Тест 3: midgame disconnect → reconnect → продолжение', async () => {
    server.configureMatchFound({ gameId: 'g-3', color: 'white' });

    const bot = new BotInstanceImpl('bot-3', 'TestBot', {
      tokens: fakeTokens,
      engine: new MockMoveEngine(['e2e4', 'd2d4'], 0),
      gameServiceUrl: server.url,
      profile: { skill: 1, defaultThinkMs: 0 },
      disableJoinJitter: true,
      shutdownTimeoutMs: 200,
      reconnectBackoffsMs: [50, 100, 200, 400, 800],
    });

    await bot.connect('bullet', { timeInitial: 60, increment: 0 });
    await waitFor(() => bot.state === 'in_game', 2_000);

    // Симулируем дисконнект: рвём ВСЕ соединения с mock-сервера.
    server.disconnectAll();

    // Ждём, что инстанс восстановит in_game (через reconnect → game-сокет).
    await waitFor(
      () => bot.state === 'in_game' && server.receivedMatchmakingJoins() === 1,
      3_000,
    );
    // mm:join был ровно один (reconnect для in_game идёт через game-сокет).

    await bot.shutdown();
  });

  it('Тест 4: 5 неуспешных reconnect → state=failed', async () => {
    // Закрываем сервер сразу — все попытки будут неуспешны.
    const port = new URL(server.url).port;
    await server.close();

    const failedReasons: string[] = [];
    const bot = new BotInstanceImpl('bot-4', 'TestBot', {
      tokens: fakeTokens,
      engine: new MockMoveEngine([], 0),
      gameServiceUrl: `http://127.0.0.1:${port}`,
      profile: { skill: 1, defaultThinkMs: 0 },
      disableJoinJitter: true,
      shutdownTimeoutMs: 200,
      // Сжатые backoff'ы — чтобы тест прошёл за ~2 сек, а не за 45.
      reconnectBackoffsMs: [10, 20, 40, 80, 100],
    });
    bot['deps'].onFailed = (_i, reason) => failedReasons.push(reason);

    // connect не должен бросить — ошибка приходит асинхронно через
    // connect_error.
    await bot.connect('bullet', { timeInitial: 60, increment: 0 });

    await waitFor(() => bot.state === 'failed', 5_000);
    expect(failedReasons.length).toBe(1);
    expect(failedReasons[0]).toMatch(/reconnect exhausted/);
    // Сервер уже закрыт; afterEach.close() стал идемпотентным.
  });

  it('Тест 5: idempotent JOIN — ALREADY_IN_QUEUE молча игнорится', async () => {
    server.setAlreadyInQueueResponse(true);

    const states: BotInstanceState[] = [];
    const bot = new BotInstanceImpl('bot-5', 'TestBot', {
      tokens: fakeTokens,
      engine: new MockMoveEngine([], 0),
      gameServiceUrl: server.url,
      profile: { skill: 1, defaultThinkMs: 0 },
      disableJoinJitter: true,
      shutdownTimeoutMs: 200,
      onStateChange: (_i, _p, n) => states.push(n),
    });

    await bot.connect('bullet', { timeInitial: 60, increment: 0 });

    // Должны попасть в in_queue (handshake прошёл, JOIN отправлен) и
    // остаться там — ALREADY_IN_QUEUE error не переводит в failed.
    await waitFor(() => bot.state === 'in_queue', 2_000);
    // Подождём ещё, чтобы убедиться что failed не наступает.
    await new Promise((r) => setTimeout(r, 200));
    expect(bot.state).toBe('in_queue');
    expect(states).not.toContain('failed');

    await bot.shutdown();
  });
});
