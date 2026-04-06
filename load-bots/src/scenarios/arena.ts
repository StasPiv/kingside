import { Socket } from 'socket.io-client';
import { BotUser } from '../bot-user.js';
import { ChessBrain } from '../chess-brain.js';
import { Metrics } from '../metrics.js';
import { Config } from '../config.js';

/**
 * Arena tournament: create tournament, N bots join, play rounds via WS.
 * Flow: create → join → subscribe WS → seek → get paired → play game → repeat.
 */
export async function runArenaScenario(config: Config, metrics: Metrics): Promise<void> {
  const botCount = Math.min(config.concurrency, 32);
  console.log(`[Arena] ${botCount} bots, duration ${config.durationSec}s`);

  // Create bots and login
  const bots: BotUser[] = [];
  for (let i = 0; i < botCount; i++) {
    const bot = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}T${i}`, metrics);
    await bot.login(config.devBypassSecret);
    bots.push(bot);
  }

  // First bot creates the tournament
  const startsAt = new Date(Date.now() + 10_000).toISOString();
  let tournament: { id: string };
  try {
    tournament = await bots[0].post<{ id: string }>('/api/arena', {
      name: `LoadBot Arena ${Date.now()}`,
      type: 'arena',
      timeInitialSec: 180,
      timeIncrementSec: 0,
      durationMin: Math.max(30, Math.ceil(config.durationSec / 60)),
      startsAt,
    });
  } catch (e: unknown) {
    console.error('[Arena] Failed to create tournament:', (e as Error).message);
    bots.forEach((b) => b.disconnect());
    return;
  }

  const tournamentId = tournament.id;
  console.log(`[Arena] Tournament ${tournamentId} created, joining ${botCount} bots...`);

  // All bots join the tournament
  for (const bot of bots) {
    try {
      await bot.post(`/api/arena/${tournamentId}/join`, {});
    } catch {
      metrics.recordError();
    }
  }

  // All bots subscribe via WS and seek games
  const botPromises = bots.map((bot) => runBotInArena(bot, tournamentId, config, metrics));
  await Promise.all(botPromises);

  // Cleanup
  bots.forEach((b) => b.disconnect());
  console.log(`[Arena] Tournament done`);
}

async function runBotInArena(
  bot: BotUser,
  tournamentId: string,
  config: Config,
  metrics: Metrics,
): Promise<void> {
  const endTime = Date.now() + config.durationSec * 1000;
  const socket = bot.connectWs('/tournament');

  return new Promise((resolve) => {
    let currentGameId: string | null = null;
    let gameSocket: Socket | null = null;
    let tournamentStarted = false;

    const cleanup = () => {
      socket.disconnect();
      if (gameSocket) gameSocket.disconnect();
      resolve();
    };

    const timeout = setTimeout(cleanup, config.durationSec * 1000 + 5000);

    const trySeeking = () => {
      if (Date.now() < endTime && !currentGameId) {
        socket.emit('tournament:seek', { tournamentId });
      }
    };

    socket.on('connect', () => {
      socket.emit('tournament:subscribe', { tournamentId });
      // Don't seek immediately — wait for tournament:started
    });

    socket.on('tournament:started', () => {
      tournamentStarted = true;
      trySeeking();
    });

    socket.on('tournament:paired', (data: { gameId: string; color: 'white' | 'black' }) => {
      currentGameId = data.gameId;
      metrics.recordGameStarted();

      // Play the game via /game namespace
      playArenaGame(bot, data.gameId, data.color, config, metrics).then(() => {
        metrics.recordGameCompleted();
        currentGameId = null;

        // Seek next game if time remains
        if (Date.now() < endTime) {
          setTimeout(trySeeking, 2000);
        } else {
          clearTimeout(timeout);
          cleanup();
        }
      });
    });

    socket.on('tournament:finished', () => {
      clearTimeout(timeout);
      cleanup();
    });

    socket.on('connect_error', () => {
      metrics.recordError();
      clearTimeout(timeout);
      cleanup();
    });
  });
}

function playArenaGame(
  bot: BotUser,
  gameId: string,
  myColor: 'white' | 'black',
  config: Config,
  metrics: Metrics,
): Promise<void> {
  return new Promise((resolve) => {
    const brain = new ChessBrain('smart');
    const socket = bot.connectWs('/game');
    let gameOver = false;

    const finish = () => {
      if (gameOver) return;
      gameOver = true;
      socket.disconnect();
      resolve();
    };

    const timeout = setTimeout(() => {
      if (!gameOver) {
        socket.emit('game:resign', { gameId });
        setTimeout(finish, 500);
      }
    }, 60_000);

    socket.on('connect', () => {
      socket.emit('game:join', { gameId });
    });

    socket.on('game:state', (state: { fen: string; status: string }) => {
      if (gameOver || state.status !== 'active') { clearTimeout(timeout); finish(); return; }
      brain.loadFen(state.fen);
      if (isMyTurn(state.fen, myColor)) makeMove(socket, brain, gameId, config, metrics);
    });

    socket.on('game:move', (data: { fen: string }) => {
      if (gameOver) return;
      brain.loadFen(data.fen);
      if (isMyTurn(data.fen, myColor)) makeMove(socket, brain, gameId, config, metrics);
    });

    socket.on('game:end', () => { clearTimeout(timeout); finish(); });
    socket.on('connect_error', () => { metrics.recordError(); clearTimeout(timeout); finish(); });
  });
}

function isMyTurn(fen: string, color: 'white' | 'black'): boolean {
  const turn = fen.split(' ')[1];
  return (color === 'white' && turn === 'w') || (color === 'black' && turn === 'b');
}

function makeMove(socket: Socket, brain: ChessBrain, gameId: string, config: Config, metrics: Metrics): void {
  const [minMs, maxMs] = config.thinkTimeMs;
  const delay = minMs + Math.random() * (maxMs - minMs) * 0.5; // faster in arena
  setTimeout(() => {
    const uci = brain.pickMove();
    if (uci) {
      socket.emit('game:move', { gameId, uci });
      metrics.recordMove();
    }
  }, delay);
}
