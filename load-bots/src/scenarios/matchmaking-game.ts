import { BotUser } from '../bot-user.js';
import { ChessBrain } from '../chess-brain.js';
import { Metrics } from '../metrics.js';
import { Config } from '../config.js';
import { Socket } from 'socket.io-client';

const MAX_MOVES = 200; // safety limit

interface MatchResult {
  gameId: string;
  color: 'white' | 'black';
}

/**
 * Run a single game between two bot users via matchmaking.
 * Both bots join matchmaking, get matched, play moves, game ends.
 */
export async function playMatchmakingGame(
  botA: BotUser,
  botB: BotUser,
  config: Config,
  metrics: Metrics,
): Promise<void> {
  // Both join matchmaking concurrently
  const [matchA, matchB] = await Promise.all([
    joinMatchmaking(botA, config),
    joinMatchmaking(botB, config),
  ]);

  if (!matchA || !matchB) {
    console.log(`[${botA.username}/${botB.username}] Matchmaking failed`);
    return;
  }

  metrics.recordGameStarted();

  // Both should be in the same game
  const gameId = matchA.gameId;

  // Play the game
  await Promise.all([
    playGame(botA, gameId, matchA.color, config, metrics),
    playGame(botB, gameId, matchB.color, config, metrics),
  ]);

  metrics.recordGameCompleted();
}

function joinMatchmaking(bot: BotUser, config: Config): Promise<MatchResult | null> {
  return new Promise((resolve) => {
    const socket = bot.connectWs('/matchmaking');
    const timeout = setTimeout(() => {
      socket.disconnect();
      resolve(null);
    }, 30_000);

    socket.on('connect', () => {
      socket.emit('matchmaking:join', {
        timeInitial: 300,
        increment: 0,
      });
    });

    socket.on('matchmaking:found', (data: MatchResult) => {
      clearTimeout(timeout);
      socket.disconnect();
      resolve(data);
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      metrics.recordError();
      socket.disconnect();
      resolve(null);
    });

    socket.on('connect_error', () => {
      clearTimeout(timeout);
      metrics.recordError();
      resolve(null);
    });
  });
}

function playGame(
  bot: BotUser,
  gameId: string,
  myColor: 'white' | 'black',
  config: Config,
  metrics: Metrics,
): Promise<void> {
  return new Promise((resolve) => {
    const brain = new ChessBrain('smart');
    const socket = bot.connectWs('/game');
    let moveCount = 0;
    let gameOver = false;

    const cleanup = () => {
      gameOver = true;
      socket.disconnect();
      resolve();
    };

    const timeout = setTimeout(() => {
      if (!gameOver) {
        // Resign on timeout
        socket.emit('game:resign', { gameId });
        setTimeout(cleanup, 500);
      }
    }, 90_000);

    socket.on('connect', () => {
      socket.emit('game:join', { gameId });
    });

    socket.on('game:state', (state: { fen: string; moves: string[]; status: string }) => {
      if (gameOver) return;
      brain.loadFen(state.fen);

      if (state.status !== 'active') {
        clearTimeout(timeout);
        cleanup();
        return;
      }

      // Check if it's our turn
      const isWhiteTurn = state.fen.split(' ')[1] === 'w';
      const isMyTurn = (myColor === 'white' && isWhiteTurn) || (myColor === 'black' && !isWhiteTurn);

      if (isMyTurn) {
        scheduleMove(socket, brain, gameId, myColor, config, metrics, moveCount, () => {
          moveCount++;
          if (moveCount >= MAX_MOVES) {
            socket.emit('game:resign', { gameId });
          }
        });
      }
    });

    socket.on('game:move', (data: { uci: string; fen: string }) => {
      if (gameOver) return;
      brain.loadFen(data.fen);

      // Check if it's our turn now
      const isWhiteTurn = data.fen.split(' ')[1] === 'w';
      const isMyTurn = (myColor === 'white' && isWhiteTurn) || (myColor === 'black' && !isWhiteTurn);

      if (isMyTurn) {
        scheduleMove(socket, brain, gameId, myColor, config, metrics, moveCount, () => {
          moveCount++;
          if (moveCount >= MAX_MOVES) {
            socket.emit('game:resign', { gameId });
          }
        });
      }
    });

    socket.on('game:end', () => {
      clearTimeout(timeout);
      cleanup();
    });

    socket.on('error', () => {
      metrics.recordError();
    });

    socket.on('connect_error', () => {
      clearTimeout(timeout);
      metrics.recordError();
      cleanup();
    });
  });
}

function scheduleMove(
  socket: Socket,
  brain: ChessBrain,
  gameId: string,
  _color: string,
  config: Config,
  metrics: Metrics,
  _moveCount: number,
  onDone: () => void,
): void {
  const [minMs, maxMs] = config.thinkTimeMs;
  const delay = minMs + Math.random() * (maxMs - minMs);

  setTimeout(() => {
    const uci = brain.pickMove();
    if (!uci) {
      // No legal moves — game should end
      return;
    }

    const start = Date.now();
    socket.emit('game:move', { gameId, uci });
    metrics.recordLatency(Date.now() - start);
    metrics.recordMove();
    onDone();
  }, delay);
}

/**
 * Run N concurrent matchmaking games.
 * Creates 2*N bots, pairs them, plays games.
 */
export async function runMatchmakingScenario(config: Config, metrics: Metrics): Promise<void> {
  const pairs = config.concurrency;
  console.log(`[Matchmaking] Starting ${pairs} pairs (${pairs * 2} bots) for ${config.durationSec}s`);

  const endTime = Date.now() + config.durationSec * 1000;
  let round = 0;

  while (Date.now() < endTime) {
    round++;
    const batchSize = Math.min(pairs, 5); // max 5 pairs per batch
    const promises: Promise<void>[] = [];

    for (let i = 0; i < batchSize; i++) {
      const idx = (round - 1) * batchSize + i;
      const botA = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}A${idx}`, metrics);
      const botB = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}B${idx}`, metrics);

      promises.push(
        (async () => {
          try {
            await botA.login(config.devBypassSecret);
            await botB.login(config.devBypassSecret);
            await playMatchmakingGame(botA, botB, config, metrics);
          } catch (e: unknown) {
            metrics.recordError();
            console.error(`[Game pair ${idx}] Error:`, (e as Error).message);
          } finally {
            botA.disconnect();
            botB.disconnect();
          }
        })(),
      );
    }

    await Promise.all(promises);

    if (Date.now() >= endTime) break;
    // Brief pause between rounds
    await new Promise((r) => setTimeout(r, 1000));
  }
}
