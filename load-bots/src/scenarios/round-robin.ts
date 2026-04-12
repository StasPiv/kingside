import { BotUser } from '../bot-user.js';
import { ChessBrain } from '../chess-brain.js';
import { Metrics } from '../metrics.js';
import { Config } from '../config.js';

/**
 * Round Robin tournament: create tournament, N bots join, server manages rounds.
 * Flow: create → join → subscribe WS → wait for tournament:paired → play game → wait for next round → repeat.
 * Key difference from arena: bots do NOT seek, server sends pairings per round.
 */
export async function runRoundRobinScenario(config: Config, metrics: Metrics): Promise<void> {
  const botCount = config.concurrency;
  const timeInitialSec = parseInt(process.env.TIME_INITIAL_SEC || '180', 10);
  const cycles = parseInt(process.env.ROUND_ROBIN_ROUNDS || '1', 10);
  const paddedCount = botCount + (botCount % 2); // pad for BYE
  const estimatedRounds = cycles * (paddedCount - 1);
  console.log(`[RoundRobin] ${botCount} bots, ${cycles} cycle(s) = ~${estimatedRounds} rounds, time ${timeInitialSec}s`);

  // Create bots and login
  const bots: BotUser[] = [];
  for (let i = 0; i < botCount; i++) {
    const bot = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}RR${i}`, metrics);
    await bot.login(config.devBypassSecret);
    bots.push(bot);
  }

  // First bot creates the round-robin tournament
  const startsAt = new Date(Date.now() + 10_000).toISOString();
  let tournament: { id: string };
  try {
    tournament = await bots[0].post<{ id: string }>('/api/arena', {
      name: `LoadBot RoundRobin ${Date.now()}`,
      type: 'round-robin',
      timeInitialSec,
      timeIncrementSec: 0,
      durationMin: 30,
      cycles,
      roundPauseMin: 0,
      startsAt,
    });
  } catch (e: unknown) {
    console.error('[RoundRobin] Failed to create tournament:', (e as Error).message);
    bots.forEach((b) => b.disconnect());
    return;
  }

  const tournamentId = tournament.id;
  console.log(`[RoundRobin] Tournament ${tournamentId} created, joining ${botCount} bots...`);

  // All bots join the tournament
  for (const bot of bots) {
    try {
      await bot.post(`/api/arena/${tournamentId}/join`, {});
    } catch {
      metrics.recordError();
    }
  }

  // All bots wait for pairings until tournament:finished
  const safetyMin = estimatedRounds * 5 + 10; // 5 min per round + 10 min buffer
  const botPromises = bots.map((bot) => runBotInRoundRobin(bot, tournamentId, config, metrics, safetyMin));
  await Promise.all(botPromises);

  // Print final standings
  try {
    const standings = await bots[0].get<Array<{ username: string; score: number; gamesPlayed: number }>>(`/api/arena/${tournamentId}/standings`);
    console.log(`[RoundRobin] Final standings:`);
    for (const s of standings) {
      console.log(`  ${s.username}: ${s.score} pts (${s.gamesPlayed} games)`);
    }
  } catch { /* ignore */ }

  // Cleanup
  bots.forEach((b) => b.disconnect());
  console.log(`[RoundRobin] Tournament done`);
}

async function runBotInRoundRobin(
  bot: BotUser,
  tournamentId: string,
  config: Config,
  metrics: Metrics,
  safetyMin: number,
): Promise<void> {
  const socket = bot.connectWs('/tournament');

  return new Promise((resolve) => {
    let currentGameId: string | null = null;
    let finished = false;
    let gamesPlayed = 0;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      socket.disconnect();
      resolve();
    };

    // Safety timeout
    const safetyMs = safetyMin * 60_000;
    const timeout = setTimeout(() => {
      console.log(`[${bot.username}] Safety timeout (${safetyMin}min), games=${gamesPlayed}`);
      cleanup();
    }, safetyMs);

    const handlePaired = async (data: { gameId: string; color: 'white' | 'black' }) => {
      if (finished) return;
      currentGameId = data.gameId;
      metrics.recordGameStarted();
      console.log(`[${bot.username}] Paired: game=${data.gameId.slice(0, 8)} color=${data.color}`);

      // Re-login before each game to avoid expired JWT (15min expiry)
      try {
        await bot.login(config.devBypassSecret);
      } catch (e) {
        console.error(`[${bot.username}] Re-login failed: ${(e as Error).message}`);
        metrics.recordError();
        currentGameId = null;
        return;
      }

      playRoundRobinGame(bot, data.gameId, data.color, config, metrics).then(() => {
        metrics.recordGameCompleted();
        gamesPlayed++;
        currentGameId = null;
        console.log(`[${bot.username}] Game done (${gamesPlayed} total), waiting for next round...`);
      });
    };

    const handleFinished = () => {
      console.log(`[${bot.username}] Tournament finished, games=${gamesPlayed}`);
      clearTimeout(timeout);
      cleanup();
    };

    const setupSocketHandlers = (sock: typeof socket) => {
      sock.on('connect', () => {
        sock.emit('tournament:subscribe', { tournamentId });
      });

      sock.on('tournament:started', () => {
        console.log(`[${bot.username}] Tournament started, waiting for pairings...`);
      });

      sock.on('tournament:paired', handlePaired);

      sock.on('tournament:round_start', (data: { roundNumber: number }) => {
        console.log(`[${bot.username}] Round ${data.roundNumber} started`);
      });

      sock.on('tournament:round_end', (data: { roundNumber: number; nextRoundStartsAt: string | null }) => {
        console.log(`[${bot.username}] Round ${data.roundNumber} ended${data.nextRoundStartsAt ? `, next at ${data.nextRoundStartsAt}` : ''}`);
      });

      sock.on('tournament:finished', handleFinished);
    };

    setupSocketHandlers(socket);

    socket.on('disconnect', async () => {
      if (finished) return;
      console.log(`[${bot.username}] /tournament disconnected, reconnecting...`);
      try {
        const newSocket = await bot.reconnectWs('/tournament');
        setupSocketHandlers(newSocket);
        newSocket.on('disconnect', async () => {
          if (!finished) {
            console.log(`[${bot.username}] /tournament disconnected again`);
            metrics.recordError();
          }
        });
      } catch {
        metrics.recordError();
      }
    });

    socket.on('error', async (err: { code?: string }) => {
      if (err.code === 'AUTH_REQUIRED' && !finished) {
        console.log(`[${bot.username}] Tournament AUTH_REQUIRED, re-login → reconnect`);
        try {
          const newSocket = await bot.reconnectWs('/tournament');
          setupSocketHandlers(newSocket);
        } catch {
          console.error(`[${bot.username}] Tournament re-login failed`);
          metrics.recordError();
        }
      }
    });

    socket.on('connect_error', () => {
      metrics.recordError();
      clearTimeout(timeout);
      cleanup();
    });
  });
}

function playRoundRobinGame(
  bot: BotUser,
  gameId: string,
  myColor: 'white' | 'black',
  config: Config,
  metrics: Metrics,
): Promise<void> {
  return new Promise((resolve) => {
    let authRetried = false;
    const brain = new ChessBrain('smart');
    const socket = bot.connectWs('/game');
    let gameOver = false;
    let moveCount = 0;
    let lastServerFen = '';
    let gotGameState = false;
    let statusPollInterval: ReturnType<typeof setInterval> | null = null;
    let stateCheckTimeout: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (gameOver) return;
      gameOver = true;
      if (statusPollInterval) clearInterval(statusPollInterval);
      if (stateCheckTimeout) clearTimeout(stateCheckTimeout);
      socket.disconnect();
      resolve();
    };

    // REST fallback: fetch game state if WS game:state not received within 3s
    const fetchStateViaRest = async () => {
      if (gameOver || gotGameState) return;
      try {
        const game = await bot.get<{ status: string; fen: string }>(`/api/games/${gameId}`);
        if (gameOver || gotGameState) return;
        console.log(`[${bot.username}/${myColor}] REST fallback: fen=${game.fen?.substring(0, 30)} status=${game.status}`);
        if (game.status === 'finished' || game.status === 'aborted') {
          clearTimeout(timeout);
          finish();
          return;
        }
        gotGameState = true;
        lastServerFen = game.fen;
        try { brain.loadFen(game.fen); } catch { /* ignore */ }
        tryMove();
      } catch (e) {
        console.error(`[${bot.username}/${myColor}] REST fallback failed:`, (e as Error).message);
      }
    };

    const timeout = setTimeout(() => {
      if (!gameOver) {
        console.log(`[${bot.username}/${myColor}] RESIGN: 600s timeout, moves=${moveCount}`);
        socket.emit('game:resign', { gameId });
        setTimeout(finish, 500);
      }
    }, 600_000);

    // Fallback: poll REST every 15s to detect missed game:end
    statusPollInterval = setInterval(async () => {
      if (gameOver) return;
      try {
        const game = await bot.get<{ status: string }>(`/api/games/${gameId}`);
        if (game.status === 'finished' || game.status === 'aborted') {
          console.log(`[${bot.username}/${myColor}] REST poll: game ${gameId.slice(0, 8)} is ${game.status}`);
          clearTimeout(timeout);
          finish();
        }
      } catch { /* ignore */ }
    }, 15_000);

    const tryMove = () => {
      if (gameOver || !lastServerFen) return;
      const turn = lastServerFen.split(' ')[1];
      const isMyTurnNow = (myColor === 'white' && turn === 'w') || (myColor === 'black' && turn === 'b');
      if (!isMyTurnNow) return;

      const [minMs, maxMs] = config.thinkTimeMs;
      const delay = minMs + Math.random() * (maxMs - minMs) * 0.5;
      setTimeout(() => {
        if (gameOver) return;
        try {
          const uci = brain.pickMove();
          if (!uci) return;
          socket.emit('game:move', { gameId, uci });
          metrics.recordMove();
          moveCount++;
        } catch (e) {
          console.error(`[${bot.username}/${myColor}] Move error:`, (e as Error).message);
          metrics.recordError();
        }
      }, delay);
    };

    socket.on('connect', () => {
      socket.emit('game:join', { gameId });
      stateCheckTimeout = setTimeout(() => fetchStateViaRest(), 3_000);
    });

    socket.on('game:state', (state: { fen: string; status: string }) => {
      if (gameOver) return;
      gotGameState = true;
      if (stateCheckTimeout) { clearTimeout(stateCheckTimeout); stateCheckTimeout = null; }
      if (state.status !== 'active') { clearTimeout(timeout); finish(); return; }
      lastServerFen = state.fen;
      try { brain.loadFen(state.fen); } catch { /* ignore */ }
      tryMove();
    });

    socket.on('game:move', (data: { fen: string }) => {
      if (gameOver) return;
      lastServerFen = data.fen;
      try { brain.loadFen(data.fen); } catch { /* ignore */ }
      tryMove();
    });

    socket.on('game:end', () => { clearTimeout(timeout); finish(); });
    socket.on('error', async (err: { code?: string }) => {
      if (err.code === 'AUTH_REQUIRED' && !authRetried) {
        authRetried = true;
        console.log(`[${bot.username}/${myColor}] AUTH_REQUIRED, re-login → retry join`);
        try {
          await bot.login(config.devBypassSecret);
          const newSocket = bot.connectWs('/game');
          newSocket.on('connect', () => newSocket.emit('game:join', { gameId }));
          newSocket.on('game:state', (state: { fen: string; status: string }) => {
            if (gameOver) return;
            if (state.status !== 'active') { clearTimeout(timeout); finish(); return; }
            lastServerFen = state.fen;
            try { brain.loadFen(state.fen); } catch { /* ignore */ }
            tryMove();
          });
          newSocket.on('game:move', (data2: { fen: string }) => {
            if (gameOver) return;
            lastServerFen = data2.fen;
            try { brain.loadFen(data2.fen); } catch { /* ignore */ }
            tryMove();
          });
          newSocket.on('game:end', () => { clearTimeout(timeout); finish(); });
          newSocket.on('error', () => { clearTimeout(timeout); finish(); });
          newSocket.on('connect_error', () => { metrics.recordError(); clearTimeout(timeout); finish(); });
        } catch {
          console.error(`[${bot.username}/${myColor}] Re-login failed`);
          metrics.recordError();
          clearTimeout(timeout);
          finish();
        }
      }
    });
    socket.on('connect_error', () => { metrics.recordError(); clearTimeout(timeout); finish(); });
  });
}
