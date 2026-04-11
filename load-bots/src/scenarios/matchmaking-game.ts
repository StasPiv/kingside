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
    joinMatchmaking(botA, config, metrics),
    joinMatchmaking(botB, config, metrics),
  ]);

  if (!matchA || !matchB) {
    console.log(`[${botA.username}/${botB.username}] Matchmaking failed`);
    return;
  }

  if (matchA.gameId !== matchB.gameId) {
    console.log(`[${botA.username}/${botB.username}] Paired with wrong opponent: A=${matchA.gameId} B=${matchB.gameId}`);
    // Play both games anyway (each bot with their actual opponent)
    metrics.recordGameStarted();
    metrics.recordGameStarted();
    await Promise.all([
      playGame(botA, matchA.gameId, matchA.color, config, metrics),
      playGame(botB, matchB.gameId, matchB.color, config, metrics),
    ]);
    metrics.recordGameCompleted();
    metrics.recordGameCompleted();
    return;
  }

  metrics.recordGameStarted();

  // Play the game — both in same game
  await Promise.all([
    playGame(botA, matchA.gameId, matchA.color, config, metrics),
    playGame(botB, matchB.gameId, matchB.color, config, metrics),
  ]);

  metrics.recordGameCompleted();
}

function joinMatchmaking(bot: BotUser, config: Config, metrics: Metrics): Promise<MatchResult | null> {
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
    let lastServerFen = '';

    const cleanup = () => {
      gameOver = true;
      socket.disconnect();
      resolve();
    };

    const timeout = setTimeout(() => {
      if (!gameOver) {
        console.log(`[${bot.username}/${myColor}] RESIGN: 600s timeout, moves=${moveCount}`);
        socket.emit('game:resign', { gameId });
        setTimeout(cleanup, 500);
      }
    }, 600_000);

    socket.on('connect', () => {
      socket.emit('game:join', { gameId });
    });

    const tryMove = () => {
      if (gameOver || !lastServerFen) return;
      const turn = lastServerFen.split(' ')[1];
      const isMyTurn = (myColor === 'white' && turn === 'w') || (myColor === 'black' && turn === 'b');
      if (!isMyTurn) return;

      scheduleMove(socket, brain, gameId, myColor, config, metrics, moveCount, () => {
        moveCount++;
        if (moveCount >= MAX_MOVES) {
          console.log(`[${bot.username}/${myColor}] RESIGN: MAX_MOVES=${MAX_MOVES}`);
          socket.emit('game:resign', { gameId });
        }
      });
    };

    socket.on('game:state', (state: { fen: string; moves: string[]; status: string; clocks?: { whiteMs: number; blackMs: number } }) => {
      if (gameOver) return;
      if (state.status !== 'active') {
        clearTimeout(timeout);
        cleanup();
        return;
      }
      lastServerFen = state.fen;
      try { brain.loadFen(state.fen); } catch { /* ignore */ }
      tryMove();
    });

    socket.on('game:move', (data: { uci: string; fen: string }) => {
      if (gameOver) return;
      lastServerFen = data.fen;
      try { brain.loadFen(data.fen); } catch { /* ignore */ }
      tryMove();
    });

    socket.on('game:end', (data: unknown) => {
      clearTimeout(timeout);
      console.log(`[${bot.username}/${myColor}] Game ended after ${moveCount} moves: ${JSON.stringify(data)}`);
      cleanup();
    });

    socket.on('error', (err: { message?: string; code?: string }) => {
      console.error(`[${bot.username}/${myColor}] WS error: ${err?.message || err?.code || JSON.stringify(err)}`);
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
    try {
      const uci = brain.pickMove();
      if (!uci) {
        console.log(`[scheduleMove] No legal moves, game should end`);
        return;
      }

      socket.emit('game:move', { gameId, uci });
      metrics.recordLatency(delay);
      metrics.recordMove();
      onDone();
    } catch (e) {
      console.error(`[scheduleMove] Error:`, (e as Error).message);
      metrics.recordError();
    }
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
    const promises: Promise<void>[] = [];

    for (let i = 0; i < pairs; i++) {
      const idx = (round - 1) * pairs + i;
      const botA = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}A${idx}`, metrics);
      const botB = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}B${idx}`, metrics);

      // Stagger pair launches by 200ms to ensure correct pairing
      // (prevents A0 matching with A1 instead of B0)
      const delay = i * 200;

      promises.push(
        (async () => {
          if (delay > 0) await sleep(delay);
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
    await sleep(1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
