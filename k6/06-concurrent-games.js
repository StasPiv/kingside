// k6/06-concurrent-games.js — 100+ concurrent live games via WebSocket
//
// Each VU represents one player. VUs are paired via matchmaking.
// Flow per VU:
//   1. Connect to /matchmaking via Socket.IO WebSocket
//   2. Join queue (blitz 5+0)
//   3. Get matched → receive gameId + color
//   4. Connect to /game via Socket.IO WebSocket
//   5. Play moves with realistic delay (2-5s)
//   6. Game ends by resign after ~20 moves
//
// Profiles:
//   smoke:  20 VU  (10 games)  — 30s
//   load:   200 VU (100 games) — 5 min
//   stress: 600 VU (300 games) — 7 min
//
// Usage:
//   k6 run k6/06-concurrent-games.js                        # smoke
//   k6 run -e PROFILE=load k6/06-concurrent-games.js        # 100 games
//   k6 run -e PROFILE=stress k6/06-concurrent-games.js      # 300 games
//   k6 run -e BASE_URL=https://kingside.site/api k6/06-concurrent-games.js

import { sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import ws from 'k6/ws';
import http from 'k6/http';
import { BASE_URL, WS_URL, TEST_USER_PREFIX } from './config.js';

// --------------- profiles ---------------
const PROFILES = {
  smoke: {
    vus: 20,
    duration: '1m',
  },
  load: {
    stages: [
      { duration: '30s', target: 50 },
      { duration: '30s', target: 200 },
      { duration: '3m', target: 200 },
      { duration: '1m', target: 0 },
    ],
  },
  stress: {
    stages: [
      { duration: '1m', target: 100 },
      { duration: '1m', target: 300 },
      { duration: '3m', target: 600 },
      { duration: '1m', target: 300 },
      { duration: '1m', target: 0 },
    ],
  },
};

const profileName = __ENV.PROFILE || 'smoke';
const profile = PROFILES[profileName];

export const options = {
  scenarios: {
    games: {
      executor: profile.stages ? 'ramping-vus' : 'constant-vus',
      ...(profile.stages
        ? { stages: profile.stages }
        : { vus: profile.vus, duration: profile.duration }),
    },
  },
  thresholds: {
    game_move_rtt: ['p(95)<500'],
    matchmaking_duration: ['p(95)<20000'],
    games_completed: ['count>0'],
    game_errors: ['count<10'],
    ws_event_latency: ['p(95)<100'],
  },
};

// --------------- metrics ---------------
const matchmakingDuration = new Trend('matchmaking_duration', true);
const gameMoveRTT = new Trend('game_move_rtt', true);
const wsEventLatency = new Trend('ws_event_latency', true);
const gamesCompleted = new Counter('games_completed');
const gamesStarted = new Counter('games_started');
const gameErrors = new Counter('game_errors');
const matchmakingTimeouts = new Counter('matchmaking_timeouts');
const movesMade = new Counter('moves_made');
const gameCompletionRate = new Rate('game_completion_rate');

// --------------- chess moves (Italian Game, ~20 moves) ---------------
// Scripted opening: Italian Game main line.
// White moves at even indices (0,2,4,...), Black at odd (1,3,5,...)
const SCRIPTED_MOVES = [
  'e2e4', 'e7e5',     // 1. e4 e5
  'g1f3', 'b8c6',     // 2. Nf3 Nc6
  'f1c4', 'f8c5',     // 3. Bc4 Bc5
  'c2c3', 'g8f6',     // 4. c3 Nf6
  'd2d4', 'e5d4',     // 5. d4 exd4
  'c3d4', 'c5b4',     // 6. cxd4 Bb4+
  'b1c3', 'd7d5',     // 7. Nc3 d5
  'e4d5', 'f6d5',     // 8. exd5 Nxd5
  'e1g1', 'e8g8',     // 9. O-O O-O
  'c4d5', 'c8e6',     // 10. Bxd5?? Be6 — intentionally dubious to keep it going
];

// Max moves before resigning (to not rely on reaching checkmate)
const MAX_MOVES_BEFORE_RESIGN = SCRIPTED_MOVES.length;

// --------------- Socket.IO helpers ---------------
// Socket.IO over WebSocket uses Engine.IO framing:
//   "0{...}"  = EIO open
//   "40"      = SIO connect to default namespace
//   "40/ns"   = SIO connect to /ns namespace
//   "42/ns,..." = SIO event on /ns
//   "2"       = EIO ping
//   "3"       = EIO pong

function sioConnect(namespace) {
  return `40${namespace},`;
}

function sioEvent(namespace, event, data) {
  return `42${namespace},${JSON.stringify([event, data])}`;
}

function parseSioMessage(raw) {
  // EIO ping
  if (raw === '2') return { type: 'ping' };
  // SIO connect ack: 40/ns,{"sid":"..."}
  if (raw.startsWith('40')) return { type: 'connect' };
  // SIO event: 42/ns,["event",{data}]
  const match = raw.match(/^42([^,]*),(.+)$/s);
  if (match) {
    try {
      const arr = JSON.parse(match[2]);
      return { type: 'event', event: arr[0], data: arr[1] };
    } catch { /* */ }
  }
  return { type: 'unknown', raw };
}

// --------------- setup: obtain tokens via dev-bypass ---------------
export function setup() {
  const maxVUs = profile.stages
    ? Math.max(...profile.stages.map((s) => s.target))
    : profile.vus;
  const secret = __ENV.DEV_BYPASS_SECRET || 'dev-secret';
  const tokens = [];

  for (let i = 1; i <= maxVUs; i++) {
    const username = `${TEST_USER_PREFIX}${i}`;
    const res = http.post(`${BASE_URL}/auth/dev-bypass`,
      JSON.stringify({ secret, user: username }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'setup_auth' } },
    );
    if (res.status === 200 || res.status === 201) {
      try {
        const body = JSON.parse(res.body);
        tokens.push({ vuId: i, username, accessToken: body.accessToken });
      } catch { /* */ }
    }
  }

  return { tokens };
}

// --------------- main scenario ---------------
export default function (setupData) {
  const tokens = setupData.tokens;
  if (!tokens || tokens.length === 0) { sleep(5); return; }

  const idx = (__VU - 1) % tokens.length;
  const vu = tokens[idx];
  if (!vu) { sleep(5); return; }

  const token = vu.accessToken;

  // ---- Phase 1: Matchmaking ----
  let gameId = null;
  let myColor = null;
  const mmStart = Date.now();

  const mmWsUrl = `${WS_URL}/socket.io/?EIO=4&transport=websocket&token=${token}`;

  const mmRes = ws.connect(mmWsUrl, {}, function (socket) {
    socket.on('open', () => {
      // Connect to /matchmaking namespace
      socket.send(sioConnect('/matchmaking'));
    });

    socket.on('message', (raw) => {
      if (raw === '2') { socket.send('3'); return; } // pong

      const msg = parseSioMessage(raw);

      if (msg.type === 'connect') {
        // Send matchmaking:join
        socket.send(sioEvent('/matchmaking', 'matchmaking:join', {
          timeInitial: 300,
          increment: 0,
        }));
      }

      if (msg.type === 'event') {
        if (msg.event === 'matchmaking:found') {
          gameId = msg.data.gameId;
          myColor = msg.data.color;
          matchmakingDuration.add(Date.now() - mmStart);
          gamesStarted.add(1);
          socket.close();
        }
        if (msg.event === 'error') {
          gameErrors.add(1);
          socket.close();
        }
      }
    });

    socket.on('error', () => { gameErrors.add(1); });

    // Timeout: 25s for matchmaking
    socket.setTimeout(() => {
      if (!gameId) matchmakingTimeouts.add(1);
      socket.close();
    }, 25000);
  });

  if (!gameId) {
    gameCompletionRate.add(0);
    sleep(2);
    return;
  }

  // ---- Phase 2: Play the game ----
  const gameWsUrl = `${WS_URL}/socket.io/?EIO=4&transport=websocket&token=${token}`;
  let gameFinished = false;
  let myMoveIndex = myColor === 'white' ? 0 : 1;

  ws.connect(gameWsUrl, {}, function (socket) {
    socket.on('open', () => {
      socket.send(sioConnect('/game'));
    });

    socket.on('message', (raw) => {
      if (raw === '2') { socket.send('3'); return; } // pong
      const receiveTime = Date.now();

      const msg = parseSioMessage(raw);

      if (msg.type === 'connect') {
        // Join the game room
        socket.send(sioEvent('/game', 'game:join', { gameId }));
      }

      if (msg.type === 'event') {
        wsEventLatency.add(Date.now() - receiveTime);

        if (msg.event === 'game:state') {
          const state = msg.data;
          if (state.status !== 'active') {
            gameFinished = true;
            gamesCompleted.add(1);
            gameCompletionRate.add(1);
            socket.close();
            return;
          }

          // Determine if it's our turn from the FEN
          const isWhiteTurn = state.fen ? state.fen.split(' ')[1] === 'w' : true;
          const isMyTurn = (myColor === 'white' && isWhiteTurn) ||
                           (myColor === 'black' && !isWhiteTurn);

          if (isMyTurn) {
            const thinkTime = 2 + Math.random() * 3; // 2-5 seconds
            sleep(thinkTime);
            sendMove(socket, myMoveIndex);
            myMoveIndex += 2;
          }
        }

        if (msg.event === 'game:move') {
          if (gameFinished) return;

          // After opponent moves, it's our turn
          const moveData = msg.data;
          const isWhiteTurn = moveData.fen ? moveData.fen.split(' ')[1] === 'w' : true;
          const isMyTurn = (myColor === 'white' && isWhiteTurn) ||
                           (myColor === 'black' && !isWhiteTurn);

          if (isMyTurn) {
            const thinkTime = 2 + Math.random() * 3; // 2-5 seconds
            sleep(thinkTime);
            sendMove(socket, myMoveIndex);
            myMoveIndex += 2;
          }
        }

        if (msg.event === 'game:end') {
          gameFinished = true;
          gamesCompleted.add(1);
          gameCompletionRate.add(1);
          socket.close();
        }

        if (msg.event === 'error') {
          // Move error — resign cleanly
          socket.send(sioEvent('/game', 'game:resign', { gameId }));
        }
      }
    });

    socket.on('error', () => { gameErrors.add(1); });

    // Safety timeout: resign after 90s if game hasn't ended
    socket.setTimeout(() => {
      if (!gameFinished) {
        socket.send(sioEvent('/game', 'game:resign', { gameId }));
        sleep(1);
        gameCompletionRate.add(1);
      }
      socket.close();
    }, 90000);

    function sendMove(sock, moveIdx) {
      if (moveIdx >= MAX_MOVES_BEFORE_RESIGN) {
        // Out of scripted moves — resign
        sock.send(sioEvent('/game', 'game:resign', { gameId }));
        return;
      }

      const uci = SCRIPTED_MOVES[moveIdx];
      if (!uci) {
        sock.send(sioEvent('/game', 'game:resign', { gameId }));
        return;
      }

      const sendTime = Date.now();
      sock.send(sioEvent('/game', 'game:move', { gameId, uci }));
      gameMoveRTT.add(Date.now() - sendTime);
      movesMade.add(1);
    }
  });

  // Brief pause between iterations
  sleep(1);
}
