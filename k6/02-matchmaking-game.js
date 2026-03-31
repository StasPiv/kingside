// k6/02-matchmaking-game.js — Matchmaking + Live Game (WebSocket)
// Pairs of VUs join matchmaking, get matched, play moves, one resigns.
//
// Usage:
//   k6 run k6/02-matchmaking-game.js
//   k6 run -e PROFILE=load k6/02-matchmaking-game.js
//   k6 run -e PROFILE=stress -e BASE_URL=https://kingside.site/api k6/02-matchmaking-game.js

import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import ws from 'k6/ws';
import { BASE_URL, WS_URL, profiles, TIME_CONTROLS, SAMPLE_MOVES } from './config.js';
import { ensureUser } from './helpers.js';

const profile = profiles[__ENV.PROFILE || 'smoke'];

export const options = {
  scenarios: {
    matchmaking: {
      executor: profile.stages ? 'ramping-vus' : 'constant-vus',
      ...(profile.stages ? { stages: profile.stages } : { vus: profile.vus, duration: profile.duration }),
    },
  },
  thresholds: {
    ...profile.thresholds,
    ws_connecting: ['p(95)<3000'],
    matchmaking_wait: ['p(95)<15000'],
    game_move_latency: ['p(95)<2000'],
  },
};

const matchmakingWait = new Trend('matchmaking_wait', true);
const gameMoveLatency = new Trend('game_move_latency', true);
const gamesCompleted = new Counter('games_completed');
const matchmakingErrors = new Counter('matchmaking_errors');

export default function () {
  const vuId = __VU;
  const tokens = ensureUser(vuId);
  if (!tokens) {
    sleep(2);
    return;
  }

  const mmUrl = `${WS_URL}/matchmaking?token=${tokens.accessToken}`;

  const mmStart = Date.now();
  let gameId = null;
  let myColor = null;

  // Phase 1: Matchmaking
  const mmRes = ws.connect(mmUrl, {}, function (socket) {
    socket.on('open', () => {
      const tc = TIME_CONTROLS.blitz;
      socket.send(JSON.stringify({
        event: 'matchmaking:join',
        data: { timeInitial: tc.timeInitial, increment: tc.increment },
      }));
    });

    socket.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);

        // Socket.IO protocol: handle connect acknowledgment
        if (typeof parsed === 'object' && parsed.sid) return;

        const event = parsed.event || parsed[0];
        const data = parsed.data || parsed[1];

        if (event === 'matchmaking:found') {
          gameId = data.gameId;
          myColor = data.color;
          matchmakingWait.add(Date.now() - mmStart);
          socket.close();
        }

        if (event === 'error') {
          matchmakingErrors.add(1);
          socket.close();
        }
      } catch { /* ignore non-JSON frames (Socket.IO handshake) */ }
    });

    socket.on('error', () => {
      matchmakingErrors.add(1);
    });

    // Timeout: close after 20s if no match
    socket.setTimeout(() => {
      socket.close();
    }, 20000);
  });

  if (!gameId) {
    sleep(2);
    return;
  }

  // Phase 2: Play the game
  const gameUrl = `${WS_URL}/game?token=${tokens.accessToken}`;

  ws.connect(gameUrl, {}, function (socket) {
    let moveIndex = myColor === 'white' ? 0 : 1;
    let gameOver = false;

    socket.on('open', () => {
      socket.send(JSON.stringify({
        event: 'game:join',
        data: { gameId },
      }));
    });

    socket.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);
        const event = parsed.event || parsed[0];
        const data = parsed.data || parsed[1];

        if (event === 'game:state' || event === 'game:move') {
          if (gameOver) return;

          // Check if it's our turn (simplified: alternate based on move index)
          if (event === 'game:state' && data.color === myColor && data.status === 'active') {
            // Make first move if white
            if (myColor === 'white' && (!data.moves || data.moves.length === 0)) {
              makeMove(socket, gameId, 0);
            }
          }

          if (event === 'game:move') {
            // Opponent moved, now we move
            sleep(0.3 + Math.random() * 0.7); // simulate thinking
            moveIndex += 2;
            if (moveIndex < SAMPLE_MOVES.length) {
              makeMove(socket, gameId, moveIndex);
            } else {
              // Out of scripted moves — resign
              socket.send(JSON.stringify({
                event: 'game:resign',
                data: { gameId },
              }));
            }
          }
        }

        if (event === 'game:end') {
          gameOver = true;
          gamesCompleted.add(1);
          socket.close();
        }

        if (event === 'error') {
          // Move error — resign to end game cleanly
          socket.send(JSON.stringify({
            event: 'game:resign',
            data: { gameId },
          }));
        }
      } catch { /* ignore */ }
    });

    // Timeout: resign and close after 60s
    socket.setTimeout(() => {
      if (!gameOver) {
        socket.send(JSON.stringify({
          event: 'game:resign',
          data: { gameId },
        }));
      }
      socket.close();
    }, 60000);
  });

  sleep(1);
}

function makeMove(socket, gameId, moveIdx) {
  const uci = SAMPLE_MOVES[moveIdx];
  if (!uci) return;
  const start = Date.now();
  socket.send(JSON.stringify({
    event: 'game:move',
    data: { gameId, uci },
  }));
  gameMoveLatency.add(Date.now() - start);
}
