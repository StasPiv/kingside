import { BotUser } from '../bot-user.js';
import { ChessBrain } from '../chess-brain.js';
import { Metrics } from '../metrics.js';
import { Config } from '../config.js';

/** Prefixed log: [ISO timestamp] [instance] message */
function log(instance: string, msg: string) {
  console.log(`[${new Date().toISOString()}] [${instance || '-'}] ${msg}`);
}
function warn(instance: string, msg: string) {
  console.warn(`[${new Date().toISOString()}] [${instance || '-'}] ${msg}`);
}

/**
 * Arena tournament: create tournament, N bots join, play rounds via WS.
 * Flow: create → join → subscribe WS → seek → get paired → play game → repeat.
 */
export async function runArenaScenario(config: Config, metrics: Metrics): Promise<void> {
  const botCount = config.concurrency;
  const durationMin = parseInt(process.env.ARENA_DURATION_MIN || '30', 10);
  const timeInitialSec = parseInt(process.env.TIME_INITIAL_SEC || '180', 10);
  log('-', `[Arena] ${botCount} bots, tournament ${durationMin}min, time ${timeInitialSec}s`);

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
      timeInitialSec,
      timeIncrementSec: 0,
      durationMin,
      startsAt,
    });
  } catch (e: unknown) {
    warn('-', `[Arena] Failed to create tournament: ${(e as Error).message}`);
    bots.forEach((b) => b.disconnect());
    return;
  }

  const tournamentId = tournament.id;
  log('-', `[Arena] Tournament ${tournamentId} created, joining ${botCount} bots...`);

  // All bots join the tournament
  for (const bot of bots) {
    try {
      await bot.post(`/api/arena/${tournamentId}/join`, {});
    } catch {
      metrics.recordError();
    }
  }

  // All bots play until tournament:finished (no DURATION_SEC dependency)
  const botPromises = bots.map((bot) => runBotInArena(bot, tournamentId, config, metrics, durationMin));
  await Promise.all(botPromises);

  // Cleanup
  bots.forEach((b) => b.disconnect());
  log('-', `[Arena] Tournament done`);
}

/** Global busy flag — shared across all bots in this process */
let serverBusy = false;

async function runBotInArena(
  bot: BotUser,
  tournamentId: string,
  config: Config,
  metrics: Metrics,
  tournamentDurationMin: number,
): Promise<void> {
  // Mutable ref — updated on every reconnect so closures (trySeeking) use the live socket
  let activeSocket = bot.connectWs('/tournament');

  return new Promise((resolve) => {
    let currentGameId: string | null = null;
    let finished = false;
    let seekInterval: ReturnType<typeof setInterval> | null = null;
    let seekPaused = false;
    let serverInstanceId = ''; // updated from playArenaGame via closure

    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (seekInterval) clearInterval(seekInterval);
      activeSocket.disconnect();
      resolve();
    };

    // Safety timeout: tournament duration + 5 min buffer (for startsAt delay + last game)
    const safetyMs = (tournamentDurationMin + 5) * 60_000;
    const timeout = setTimeout(cleanup, safetyMs);

    const trySeeking = () => {
      if (!finished && !currentGameId && !seekPaused && !serverBusy) {
        activeSocket.emit('tournament:seek', { tournamentId });
      }
    };

    const startSeekLoop = () => {
      if (seekInterval) clearInterval(seekInterval);
      seekPaused = false;
      seekInterval = setInterval(trySeeking, 5_000);
      trySeeking();
    };

    const stopSeekLoop = () => {
      if (seekInterval) { clearInterval(seekInterval); seekInterval = null; }
    };

    const pauseSeekLoop = () => { seekPaused = true; };
    const resumeSeekLoop = () => { seekPaused = false; trySeeking(); };

    /** Wire all event handlers onto a socket and update activeSocket ref */
    const wireSocket = (sock: ReturnType<typeof bot.connectWs>) => {
      // Disconnect previous socket to avoid duplicate event delivery
      if (activeSocket && activeSocket !== sock) {
        activeSocket.removeAllListeners();
        activeSocket.disconnect();
      }
      activeSocket = sock;

      sock.on('connect', () => {
        sock.emit('tournament:subscribe', { tournamentId });
      });

      sock.on('server:instance', (data: { instanceId: string }) => {
        serverInstanceId = data.instanceId ?? '';
      });

      sock.on('server:busy', () => { serverBusy = true; pauseSeekLoop(); });
      sock.on('server:ready', () => { serverBusy = false; if (!finished && !currentGameId) resumeSeekLoop(); });

      sock.on('tournament:started', () => startSeekLoop());

      sock.on('tournament:paired', (data: { gameId: string; color: 'white' | 'black' }) => {
        // Ignore duplicate paired events for same game or if already playing
        if (currentGameId) {
          log(serverInstanceId, `[${bot.username}] tournament:paired IGNORED (already in game ${currentGameId.slice(0, 8)}) dup=${data.gameId.slice(0, 8)}`);
          return;
        }
        const pairedAt = Date.now();
        log(serverInstanceId, `[${bot.username}] tournament:paired game=${data.gameId.slice(0, 8)} color=${data.color}`);
        currentGameId = data.gameId;
        stopSeekLoop();
        metrics.recordGameStarted();

        playArenaGame(bot, data.gameId, data.color, config, metrics, pairedAt).then(() => {
          metrics.recordGameCompleted();
          currentGameId = null;
          if (!finished) setTimeout(() => startSeekLoop(), 2000);
        });
      });

      sock.on('tournament:finished', () => { clearTimeout(timeout); cleanup(); });

      sock.on('disconnect', async () => {
        if (finished) return;
        log(serverInstanceId, `[${bot.username}] /tournament disconnected, reconnecting...`);
        try {
          wireSocket(await bot.reconnectWs('/tournament'));
        } catch { metrics.recordError(); }
      });

      sock.on('error', async (err: { code?: string }) => {
        if (err.code === 'AUTH_REQUIRED' && !finished) {
          log(serverInstanceId, `[${bot.username}] Tournament AUTH_REQUIRED, re-login → reconnect`);
          try {
            wireSocket(await bot.reconnectWs('/tournament'));
          } catch {
            warn(serverInstanceId, `[${bot.username}] Tournament re-login failed`);
            metrics.recordError();
          }
        }
      });

      sock.on('connect_error', async (err: Error) => {
        let retryAfter = 0;
        try {
          const parsed = JSON.parse(err.message);
          if (parsed.type === 'server_busy') retryAfter = parsed.retryAfter || 60;
        } catch { /* not JSON */ }

        if (retryAfter > 0 && !finished) {
          log(serverInstanceId, `[${bot.username}] /tournament server_busy, retry in ${retryAfter}s`);
          serverBusy = true;
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          if (!finished) {
            try { wireSocket(await bot.reconnectWs('/tournament')); }
            catch { metrics.recordError(); }
          }
        } else {
          metrics.recordError();
          clearTimeout(timeout);
          cleanup();
        }
      });
    };

    // Wire initial socket
    wireSocket(activeSocket);
  });
}

function playArenaGame(
  bot: BotUser,
  gameId: string,
  myColor: 'white' | 'black',
  config: Config,
  metrics: Metrics,
  pairedAt = Date.now(),
): Promise<void> {
  return new Promise((resolve) => {
    let authRetried = false;
    let serverInstanceId = '';
    const brain = new ChessBrain('smart');
    const connectStartMs = Date.now();
    log(serverInstanceId, `[${bot.username}/${myColor}] PAIRED→CONNECT game=${gameId.slice(0, 8)} delay=${connectStartMs - pairedAt}ms`);
    const socket = bot.connectWs('/game');
    let gameOver = false;
    let moveCount = 0;
    let lastServerFen = '';
    let gotGameState = false;
    let firstMoveEmittedAt = 0;
    let stateCheckTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastStateReceivedAt = 0; // timestamp of last game:state or game:move received
    const gameStartedAt = Date.now();

    const finish = () => {
      if (gameOver) return;
      gameOver = true;
      if (stateCheckTimeout) clearTimeout(stateCheckTimeout);
      socket.disconnect();
      resolve();
    };

    // REST fallback: fetch game state if WS game:state not received within 3s
    const fetchStateViaRest = async () => {
      if (gameOver || gotGameState) return;
      warn(serverInstanceId, `[${bot.username}/${myColor}] NO game:state after 3s, REST fallback for ${gameId.slice(0, 8)}`);
      try {
        const game = await bot.get<{ status: string; fen: string }>(`/api/games/${gameId}`);
        if (gameOver || gotGameState) return;
        log(serverInstanceId, `[${bot.username}/${myColor}] REST fallback: game:state fen=${game.fen?.substring(0, 30)} status=${game.status}`);
        if (game.status === 'finished' || game.status === 'aborted') {
          clearTimeout(timeout);
          finish();
          return;
        }
        gotGameState = true;
        lastServerFen = game.fen;
        try { brain.loadFen(game.fen); } catch { /* ignore */ }
        tryMove('fallback');
      } catch (e) {
        warn(serverInstanceId, `[${bot.username}/${myColor}] REST fallback failed: ${(e as Error).message}`);
      }
    };

    const timeout = setTimeout(() => {
      if (!gameOver) {
        log(serverInstanceId, `[${bot.username}/${myColor}] RESIGN: 600s arena timeout, moves=${moveCount}`);
        socket.emit('game:resign', { gameId });
        setTimeout(finish, 500);
      }
    }, 600_000);

    // REST poll removed — rely on WS game:end event

    const tryMove = (source = 'unknown') => {
      if (gameOver) { log(serverInstanceId, `[${bot.username}/${myColor}] tryMove(${source}): skip gameOver=true`); return; }
      if (!lastServerFen) { log(serverInstanceId, `[${bot.username}/${myColor}] tryMove(${source}): skip no fen`); return; }
      const turn = lastServerFen.split(' ')[1];
      const isMyTurnNow = (myColor === 'white' && turn === 'w') || (myColor === 'black' && turn === 'b');
      if (!isMyTurnNow) { log(serverInstanceId, `[${bot.username}/${myColor}] tryMove(${source}): skip notMyTurn turn=${turn}`); return; }

      const [minMs, maxMs] = config.thinkTimeMs;
      const delay = minMs + Math.random() * (maxMs - minMs) * 0.5; // faster in arena
      setTimeout(() => {
        if (gameOver) return;
        try {
          const uci = brain.pickMove();
          if (!uci) return;
          const now = Date.now();
          const latency = lastStateReceivedAt ? now - lastStateReceivedAt : -1;
          socket.emit('game:move', { gameId, uci });
          metrics.recordMove();
          moveCount++;
          if (moveCount === 1) {
            firstMoveEmittedAt = now;
            const stateToMove = lastStateReceivedAt ? now - lastStateReceivedAt : -1;
            const pairedToMove = now - pairedAt;
            log(serverInstanceId, `[${bot.username}/${myColor}] FIRST_MOVE game=${gameId.slice(0, 8)} uci=${uci} state→move=${stateToMove}ms paired→move=${pairedToMove}ms instance=${serverInstanceId}`);
          } else if (latency > 5000) {
            log(serverInstanceId, `[${bot.username}/${myColor}] EMIT game:move #${moveCount} uci=${uci} latency=${latency}ms (state→move)`);
          }
        } catch (e) {
          warn(serverInstanceId, `[${bot.username}/${myColor}] Move error: ${(e as Error).message}`);
          metrics.recordError();
        }
      }, delay);
    };

    socket.on('server:instance', (data: { instanceId: string }) => {
      serverInstanceId = data.instanceId ?? '';
      const handshakeMs = Date.now() - connectStartMs;
      log(serverInstanceId, `[${bot.username}/${myColor}] WS_HANDSHAKE game=${gameId.slice(0, 8)} duration=${handshakeMs}ms instance=${serverInstanceId}`);
    });

    socket.on('connect', () => {
      socket.emit('game:join', { gameId });
      // Fallback: if game:state not received within 3s, fetch via REST
      stateCheckTimeout = setTimeout(() => fetchStateViaRest(), 3_000);
    });

    socket.on('game:state', (state: { fen: string; status: string }) => {
      lastStateReceivedAt = Date.now();
      const sinceStart = lastStateReceivedAt - gameStartedAt;
      const turn = state.fen?.split(' ')[1];
      const isMyTurn = (myColor === 'white' && turn === 'w') || (myColor === 'black' && turn === 'b');
      log(serverInstanceId, `[${bot.username}/${myColor}] game:state status=${state.status} turn=${turn} myTurn=${isMyTurn} gameOver=${gameOver} +${sinceStart}ms`);
      if (gameOver) return;
      gotGameState = true;
      if (stateCheckTimeout) { clearTimeout(stateCheckTimeout); stateCheckTimeout = null; }
      if (state.status !== 'active') { log(serverInstanceId, `[${bot.username}/${myColor}] game:state not active, finishing`); clearTimeout(timeout); finish(); return; }
      lastServerFen = state.fen;
      try { brain.loadFen(state.fen); } catch { /* ignore */ }
      if (isMyTurn) tryMove('game:state');
    });

    socket.on('game:move', (data: { fen: string }) => {
      lastStateReceivedAt = Date.now();
      if (gameOver) return;
      lastServerFen = data.fen;
      try { brain.loadFen(data.fen); } catch { /* ignore */ }
      // Only try move if it's our turn (avoid noisy "skip notMyTurn" logs)
      const turn = data.fen?.split(' ')[1];
      const isMyTurn = (myColor === 'white' && turn === 'w') || (myColor === 'black' && turn === 'b');
      if (isMyTurn) tryMove('game:move');
    });

    socket.on('game:end', (data: unknown) => {
      const elapsed = Date.now() - gameStartedAt;
      const firstMoveDelay = firstMoveEmittedAt ? firstMoveEmittedAt - pairedAt : -1;
      log(serverInstanceId, `[${bot.username}/${myColor}] game:end moves=${moveCount} gotState=${gotGameState} elapsed=${elapsed}ms paired→1st=${firstMoveDelay}ms ${JSON.stringify(data)}`);
      if (moveCount === 0) {
        warn(serverInstanceId, `[${bot.username}/${myColor}] ZERO-MOVE game=${gameId.slice(0, 8)} gotState=${gotGameState} elapsed=${elapsed}ms instance=${serverInstanceId}`);
      }
      clearTimeout(timeout);
      finish();
    });
    socket.on('error', async (err: { code?: string }) => {
      if (err.code === 'AUTH_REQUIRED' && !authRetried) {
        authRetried = true;
        log(serverInstanceId, `[${bot.username}/${myColor}] AUTH_REQUIRED, re-login → retry join`);
        try {
          await bot.login(config.devBypassSecret);
          const newSocket = bot.connectWs('/game');
          newSocket.on('connect', () => {
            log(serverInstanceId, `[${bot.username}/${myColor}] Re-auth OK, re-joining game ${gameId}`);
            newSocket.emit('game:join', { gameId });
          });
          newSocket.on('game:state', (state: { fen: string; status: string }) => {
            if (gameOver) return;
            if (state.status !== 'active') { clearTimeout(timeout); finish(); return; }
            lastServerFen = state.fen;
            try { brain.loadFen(state.fen); } catch { /* ignore */ }
            tryMove('fallback');
          });
          newSocket.on('game:move', (data2: { fen: string }) => {
            if (gameOver) return;
            lastServerFen = data2.fen;
            try { brain.loadFen(data2.fen); } catch { /* ignore */ }
            tryMove('fallback');
          });
          newSocket.on('game:end', () => { clearTimeout(timeout); finish(); });
          newSocket.on('error', () => { clearTimeout(timeout); finish(); });
          newSocket.on('connect_error', () => { metrics.recordError(); clearTimeout(timeout); finish(); });
        } catch {
          warn(serverInstanceId, `[${bot.username}/${myColor}] Re-login failed, finishing`);
          metrics.recordError();
          clearTimeout(timeout);
          finish();
        }
      }
    });
    socket.on('connect_error', async (err: Error) => {
      // Parse server_busy error with retryAfter
      let retryAfter = 0;
      try {
        const parsed = JSON.parse(err.message);
        if (parsed.type === 'server_busy') retryAfter = parsed.retryAfter || 60;
      } catch { /* not JSON — regular error */ }

      if (retryAfter > 0) {
        log(serverInstanceId, `[${bot.username}/${myColor}] /game server_busy, retry in ${retryAfter}s`);
        socket.disconnect();
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        if (!gameOver) {
          const retrySocket = bot.connectWs('/game');
          retrySocket.on('connect', () => {
            retrySocket.emit('game:join', { gameId });
          });
          retrySocket.on('game:state', (state: { fen: string; status: string }) => {
            if (gameOver) return;
            if (state.status !== 'active') { clearTimeout(timeout); finish(); return; }
            lastServerFen = state.fen;
            try { brain.loadFen(state.fen); } catch { /* ignore */ }
            tryMove('fallback');
          });
          retrySocket.on('game:move', (data2: { fen: string }) => {
            if (gameOver) return;
            lastServerFen = data2.fen;
            try { brain.loadFen(data2.fen); } catch { /* ignore */ }
            tryMove('fallback');
          });
          retrySocket.on('game:end', () => { clearTimeout(timeout); finish(); });
          retrySocket.on('connect_error', () => { metrics.recordError(); clearTimeout(timeout); finish(); });
        }
      } else {
        log(serverInstanceId, `[${bot.username}/${myColor}] /game connect_error: ${err.message}`);
        metrics.recordError();
        clearTimeout(timeout);
        finish();
      }
    });
  });
}

/** Exported for worker_threads usage */
export { runBotInArena as runBotInArenaExported };

