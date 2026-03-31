// k6/05-combined.js — Combined scenario: realistic traffic mix
// Simulates all user types simultaneously with realistic distribution:
//   - 10% players (matchmaking + games)
//   - 20% puzzle solvers
//   - 30% spectators
//   - 30% broadcast viewers
//   - 10% browsing (profile, leaderboards)
//
// Usage:
//   k6 run k6/05-combined.js
//   k6 run -e PROFILE=load k6/05-combined.js
//   k6 run -e PROFILE=stress k6/05-combined.js

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter } from 'k6/metrics';
import ws from 'k6/ws';
import { BASE_URL, WS_URL, profiles, TIME_CONTROLS, SAMPLE_MOVES } from './config.js';
import { ensureUser, authHeaders } from './helpers.js';

const profile = profiles[__ENV.PROFILE || 'smoke'];

export const options = {
  scenarios: {
    players: {
      executor: profile.stages ? 'ramping-vus' : 'constant-vus',
      ...(profile.stages
        ? { stages: profile.stages.map((s) => ({ ...s, target: Math.ceil(s.target * 0.1) })) }
        : { vus: Math.max(2, Math.ceil(profile.vus * 0.1)), duration: profile.duration }),
      exec: 'playerScenario',
    },
    puzzle_solvers: {
      executor: profile.stages ? 'ramping-vus' : 'constant-vus',
      ...(profile.stages
        ? { stages: profile.stages.map((s) => ({ ...s, target: Math.ceil(s.target * 0.2) })) }
        : { vus: Math.max(1, Math.ceil(profile.vus * 0.2)), duration: profile.duration }),
      exec: 'puzzleScenario',
    },
    spectators: {
      executor: profile.stages ? 'ramping-vus' : 'constant-vus',
      ...(profile.stages
        ? { stages: profile.stages.map((s) => ({ ...s, target: Math.ceil(s.target * 0.3) })) }
        : { vus: Math.max(1, Math.ceil(profile.vus * 0.3)), duration: profile.duration }),
      exec: 'spectatorScenario',
    },
    broadcast_viewers: {
      executor: profile.stages ? 'ramping-vus' : 'constant-vus',
      ...(profile.stages
        ? { stages: profile.stages.map((s) => ({ ...s, target: Math.ceil(s.target * 0.3) })) }
        : { vus: Math.max(1, Math.ceil(profile.vus * 0.3)), duration: profile.duration }),
      exec: 'broadcastScenario',
    },
    browsers: {
      executor: profile.stages ? 'ramping-vus' : 'constant-vus',
      ...(profile.stages
        ? { stages: profile.stages.map((s) => ({ ...s, target: Math.ceil(s.target * 0.1) })) }
        : { vus: Math.max(1, Math.ceil(profile.vus * 0.1)), duration: profile.duration }),
      exec: 'browseScenario',
    },
  },
  thresholds: {
    ...profile.thresholds,
    http_req_duration: ['p(95)<3000'],
    ws_connecting: ['p(95)<5000'],
  },
};

const scenarioErrors = new Counter('scenario_errors');

// ---------- Player: matchmaking + game ----------
export function playerScenario() {
  const vuId = 1000 + __VU; // offset to avoid collisions
  const tokens = ensureUser(vuId);
  if (!tokens) { sleep(2); return; }

  const mmUrl = `${WS_URL}/matchmaking?token=${tokens.accessToken}`;
  let gameId = null;

  ws.connect(mmUrl, {}, function (socket) {
    socket.on('open', () => {
      socket.send(JSON.stringify({
        event: 'matchmaking:join',
        data: TIME_CONTROLS.blitz,
      }));
    });
    socket.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);
        const event = parsed.event || parsed[0];
        const data = parsed.data || parsed[1];
        if (event === 'matchmaking:found') {
          gameId = data.gameId;
          socket.close();
        }
      } catch { /* */ }
    });
    socket.setTimeout(() => socket.close(), 15000);
  });

  if (!gameId) { sleep(3); return; }

  // Play a few moves then resign
  const gameUrl = `${WS_URL}/game?token=${tokens.accessToken}`;
  ws.connect(gameUrl, {}, function (socket) {
    let moves = 0;
    socket.on('open', () => {
      socket.send(JSON.stringify({ event: 'game:join', data: { gameId } }));
    });
    socket.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);
        const event = parsed.event || parsed[0];
        if (event === 'game:move' || event === 'game:state') {
          sleep(0.5);
          if (moves < 6 && moves < SAMPLE_MOVES.length) {
            socket.send(JSON.stringify({
              event: 'game:move',
              data: { gameId, uci: SAMPLE_MOVES[moves] },
            }));
            moves++;
          } else {
            socket.send(JSON.stringify({ event: 'game:resign', data: { gameId } }));
          }
        }
        if (event === 'game:end') socket.close();
      } catch { /* */ }
    });
    socket.setTimeout(() => {
      socket.send(JSON.stringify({ event: 'game:resign', data: { gameId } }));
      socket.close();
    }, 30000);
  });

  sleep(2);
}

// ---------- Puzzle solver ----------
export function puzzleScenario() {
  const vuId = 2000 + __VU;
  const tokens = ensureUser(vuId);
  if (!tokens) { sleep(2); return; }
  const opts = authHeaders(tokens.accessToken);

  group('Puzzle solving', () => {
    const next = http.get(`${BASE_URL}/puzzles/next`, {
      ...opts,
      tags: { name: 'puzzle_next' },
    });

    if (next.status === 200) {
      try {
        const puzzle = JSON.parse(next.body);
        sleep(3 + Math.random() * 7); // "thinking"

        http.post(`${BASE_URL}/puzzles/${puzzle.id}/attempts`,
          JSON.stringify({ result: Math.random() > 0.3 ? 'solved' : 'unsolved', timeMs: 5000 + Math.random() * 15000 }),
          { ...opts, tags: { name: 'puzzle_attempt' } },
        );
      } catch { /* */ }
    }

    // Daily puzzle (public)
    http.get(`${BASE_URL}/puzzles/daily`, { tags: { name: 'puzzle_daily' } });
  });

  sleep(2);
}

// ---------- Spectator ----------
export function spectatorScenario() {
  const onlinePlayers = http.get(`${BASE_URL}/players/online?limit=3`, {
    tags: { name: 'spectate_find' },
  });

  let gameId = null;
  if (onlinePlayers.status === 200) {
    try {
      const players = JSON.parse(onlinePlayers.body).data || JSON.parse(onlinePlayers.body);
      for (const p of players) {
        const gr = http.get(`${BASE_URL}/users/${p.id || p.username}/games?take=1`, {
          tags: { name: 'spectate_find' },
        });
        if (gr.status === 200) {
          const games = JSON.parse(gr.body).data || JSON.parse(gr.body);
          if (games.length > 0 && games[0].status === 'active') {
            gameId = games[0].id;
            break;
          }
        }
      }
    } catch { /* */ }
  }

  if (!gameId) { sleep(5); return; }

  ws.connect(`${WS_URL}/game`, {}, function (socket) {
    socket.on('open', () => {
      socket.send(JSON.stringify({ event: 'game:join', data: { gameId } }));
    });
    socket.on('message', () => { /* just receive */ });
    socket.setTimeout(() => socket.close(), 20000 + Math.random() * 20000);
  });

  sleep(2);
}

// ---------- Broadcast viewer ----------
export function broadcastScenario() {
  const roundId = findBroadcastRound();
  if (!roundId) { sleep(5); return; }

  ws.connect(`${WS_URL}/broadcast`, {}, function (socket) {
    socket.on('open', () => {
      socket.send(JSON.stringify({ event: 'broadcast:subscribe', data: { roundId } }));
    });
    socket.on('message', () => { /* receive sync/move events */ });
    socket.setTimeout(() => {
      socket.send(JSON.stringify({ event: 'broadcast:unsubscribe', data: { roundId } }));
      socket.close();
    }, 30000 + Math.random() * 30000);
  });

  sleep(2);
}

// ---------- Browser (REST only) ----------
export function browseScenario() {
  group('Browse', () => {
    http.get(`${BASE_URL}/broadcasts?take=10`, { tags: { name: 'browse_broadcasts' } });
    http.get(`${BASE_URL}/players/top?type=blitz&limit=20`, { tags: { name: 'browse_leaderboard' } });
    http.get(`${BASE_URL}/players/online?limit=20`, { tags: { name: 'browse_online' } });
    http.get(`${BASE_URL}/puzzles/daily`, { tags: { name: 'browse_daily' } });
    http.get(`${BASE_URL}/puzzles/themes`, { tags: { name: 'browse_themes' } });
  });

  sleep(3 + Math.random() * 5);
}

function findBroadcastRound() {
  try {
    const res = http.get(`${BASE_URL}/broadcasts?take=3`, { tags: { name: 'find_broadcast' } });
    if (res.status !== 200) return null;
    const bcs = JSON.parse(res.body).data || JSON.parse(res.body);
    for (const bc of bcs) {
      const rr = http.get(`${BASE_URL}/broadcasts/${bc.id}/rounds`, { tags: { name: 'find_round' } });
      if (rr.status !== 200) continue;
      const rounds = JSON.parse(rr.body).data || JSON.parse(rr.body);
      const ongoing = rounds.find((r) => r.status === 'ongoing');
      if (ongoing) return ongoing.id;
      const finished = rounds.filter((r) => r.status === 'finished');
      if (finished.length > 0) return finished[finished.length - 1].id;
    }
  } catch { /* */ }
  return null;
}
