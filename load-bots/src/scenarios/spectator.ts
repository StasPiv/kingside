import { io, Socket } from 'socket.io-client';
import { BotUser } from '../bot-user.js';
import { ChessBrain } from '../chess-brain.js';
import { Metrics } from '../metrics.js';
import { Config } from '../config.js';

/**
 * Spectator fan-out: 2 bots play a game, N bots spectate via WS.
 * Measures: how many spectators receive move events, delivery latency.
 */
export async function runSpectatorScenario(config: Config, metrics: Metrics): Promise<void> {
  const spectatorCount = config.concurrency;
  console.log(`[Spectator] 1 game + ${spectatorCount} spectators for ${config.durationSec}s`);

  // Create and login two players
  const playerA = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}SpA`, metrics);
  const playerB = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}SpB`, metrics);

  await playerA.login(config.devBypassSecret);
  await playerB.login(config.devBypassSecret);

  // Create game via matchmaking
  const gameId = await createGameViaMatchmaking(playerA, playerB, config);
  if (!gameId) {
    console.log('[Spectator] Failed to create game');
    return;
  }

  console.log(`[Spectator] Game ${gameId} created, connecting ${spectatorCount} spectators...`);
  metrics.recordGameStarted();

  // Connect spectators
  const spectators: Socket[] = [];
  let movesReceived = 0;

  for (let i = 0; i < spectatorCount; i++) {
    const socket = io(`${config.wsUrl}/game`, {
      transports: ['websocket'],
      reconnection: false,
    });

    socket.on('connect', () => {
      socket.emit('spectate:join', { gameId });
    });

    socket.on('spectate:move', () => {
      movesReceived++;
      metrics.recordMove();
    });

    socket.on('game:move', () => {
      movesReceived++;
      metrics.recordMove();
    });

    spectators.push(socket);

    // Stagger connections to avoid burst
    if (i % 20 === 19) await sleep(100);
  }

  await sleep(1000); // let all spectators connect
  console.log(`[Spectator] ${spectators.filter((s) => s.connected).length}/${spectatorCount} connected`);

  // Play the game
  await playGameForSpectators(playerA, playerB, gameId, config, metrics);

  // Report
  const connectedCount = spectators.filter((s) => s.connected).length;
  console.log(`[Spectator] Done. Moves received by spectators: ${movesReceived}, connected: ${connectedCount}`);

  metrics.recordGameCompleted();

  // Cleanup
  for (const s of spectators) s.disconnect();
  playerA.disconnect();
  playerB.disconnect();
}

async function createGameViaMatchmaking(
  botA: BotUser,
  botB: BotUser,
  config: Config,
): Promise<string | null> {
  return new Promise((resolve) => {
    let gameId: string | null = null;
    const sockets: Socket[] = [];

    const timeout = setTimeout(() => {
      sockets.forEach((s) => s.disconnect());
      resolve(null);
    }, 20_000);

    for (const bot of [botA, botB]) {
      const socket = bot.connectWs('/matchmaking');
      sockets.push(socket);

      socket.on('connect', () => {
        socket.emit('matchmaking:join', { timeInitial: 600, increment: 0 });
      });

      socket.on('matchmaking:found', (data: { gameId: string }) => {
        if (!gameId) {
          gameId = data.gameId;
          clearTimeout(timeout);
          sockets.forEach((s) => s.disconnect());
          resolve(gameId);
        }
      });
    }
  });
}

async function playGameForSpectators(
  botA: BotUser,
  botB: BotUser,
  gameId: string,
  config: Config,
  metrics: Metrics,
): Promise<void> {
  // Player A joins and plays as white (or whatever color assigned)
  return new Promise((resolve) => {
    const brainA = new ChessBrain('smart');
    const brainB = new ChessBrain('smart');
    let gameOver = false;
    let moveCount = 0;

    const socketA = botA.connectWs('/game');
    const socketB = botB.connectWs('/game');

    const finish = () => {
      if (gameOver) return;
      gameOver = true;
      socketA.disconnect();
      socketB.disconnect();
      resolve();
    };

    const timeout = setTimeout(() => {
      socketA.emit('game:resign', { gameId });
      setTimeout(finish, 500);
    }, config.durationSec * 1000);

    function handleState(socket: Socket, brain: ChessBrain, color: string) {
      return (state: { fen: string; status: string }) => {
        if (gameOver) return;
        brain.loadFen(state.fen);
        if (state.status !== 'active') { clearTimeout(timeout); finish(); return; }
        const isMyTurn = (color === 'white' && state.fen.split(' ')[1] === 'w') ||
                         (color === 'black' && state.fen.split(' ')[1] === 'b');
        if (isMyTurn) makeMove(socket, brain, gameId, config);
      };
    }

    function handleMove(socket: Socket, brain: ChessBrain, color: string) {
      return (data: { fen: string }) => {
        if (gameOver) return;
        brain.loadFen(data.fen);
        moveCount++;
        if (moveCount > 100) { socket.emit('game:resign', { gameId }); return; }
        const isMyTurn = (color === 'white' && data.fen.split(' ')[1] === 'w') ||
                         (color === 'black' && data.fen.split(' ')[1] === 'b');
        if (isMyTurn) makeMove(socket, brain, gameId, config);
      };
    }

    // We don't know colors in advance; assign by convention
    socketA.on('connect', () => socketA.emit('game:join', { gameId }));
    socketB.on('connect', () => socketB.emit('game:join', { gameId }));

    socketA.on('game:state', handleState(socketA, brainA, 'white'));
    socketA.on('game:move', handleMove(socketA, brainA, 'white'));
    socketA.on('game:end', () => { clearTimeout(timeout); finish(); });

    socketB.on('game:state', handleState(socketB, brainB, 'black'));
    socketB.on('game:move', handleMove(socketB, brainB, 'black'));
    socketB.on('game:end', () => { clearTimeout(timeout); finish(); });
  });
}

function makeMove(socket: Socket, brain: ChessBrain, gameId: string, config: Config): void {
  const [minMs, maxMs] = config.thinkTimeMs;
  const delay = minMs + Math.random() * (maxMs - minMs);
  setTimeout(() => {
    const uci = brain.pickMove();
    if (uci) socket.emit('game:move', { gameId, uci });
  }, delay);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
