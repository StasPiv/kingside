// k6/03-spectators.js — Spectators (WebSocket fan-out)
// Simulates many spectators watching active games.
// Tests fan-out performance: one game state update → N spectator deliveries.
//
// Usage:
//   k6 run k6/03-spectators.js
//   k6 run -e PROFILE=load k6/03-spectators.js
//   k6 run -e PROFILE=stress k6/03-spectators.js
//   k6 run -e GAME_ID=<uuid> k6/03-spectators.js      # watch specific game

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import ws from 'k6/ws';
import { BASE_URL, WS_URL, profiles } from './config.js';

const profile = profiles[__ENV.PROFILE || 'smoke'];

// Scale spectators higher than players
const spectatorMultiplier = 5;
const scaledProfile = profile.stages
  ? {
      stages: profile.stages.map((s) => ({
        duration: s.duration,
        target: s.target * spectatorMultiplier,
      })),
    }
  : { vus: profile.vus * spectatorMultiplier, duration: profile.duration };

export const options = {
  scenarios: {
    spectators: {
      executor: scaledProfile.stages ? 'ramping-vus' : 'constant-vus',
      ...(scaledProfile.stages
        ? { stages: scaledProfile.stages }
        : { vus: scaledProfile.vus, duration: scaledProfile.duration }),
    },
  },
  thresholds: {
    ...profile.thresholds,
    ws_connecting: ['p(95)<3000'],
    spectator_events_received: ['count>0'],
    spectator_state_latency: ['p(95)<2000'],
  },
};

const eventsReceived = new Counter('spectator_events_received');
const stateLatency = new Trend('spectator_state_latency', true);
const connectErrors = new Counter('spectator_connect_errors');

export default function () {
  // Find an active game to spectate
  const gameId = __ENV.GAME_ID || findActiveGame();
  if (!gameId) {
    sleep(3);
    return;
  }

  const gameUrl = `${WS_URL}/game`;

  const connectStart = Date.now();

  ws.connect(gameUrl, {}, function (socket) {
    let stateReceived = false;

    socket.on('open', () => {
      // Join as spectator (no auth needed for spectating)
      socket.send(JSON.stringify({
        event: 'game:join',
        data: { gameId },
      }));
    });

    socket.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);
        const event = parsed.event || parsed[0];

        if (event === 'spectate:state' || event === 'game:state') {
          if (!stateReceived) {
            stateLatency.add(Date.now() - connectStart);
            stateReceived = true;
          }
          eventsReceived.add(1);
        }

        if (event === 'spectate:move' || event === 'game:move') {
          eventsReceived.add(1);
        }

        if (event === 'spectate:end' || event === 'game:end') {
          eventsReceived.add(1);
          socket.close();
        }
      } catch { /* ignore */ }
    });

    socket.on('error', () => {
      connectErrors.add(1);
    });

    // Stay connected for 30-60s simulating a spectator session
    const watchDuration = 30000 + Math.random() * 30000;
    socket.setTimeout(() => {
      socket.close();
    }, watchDuration);
  });

  sleep(1);
}

/**
 * Try to find an active game via REST API.
 * Returns gameId or null.
 */
function findActiveGame() {
  // Try top online players — they might be in a game
  const res = http.get(`${BASE_URL}/players/online?limit=5`, {
    tags: { name: 'find_active_game' },
  });

  if (res.status !== 200) return null;

  try {
    const data = JSON.parse(res.body);
    const players = data.data || data;
    if (!Array.isArray(players) || players.length === 0) return null;

    // Try to get active game for first online player
    for (const player of players) {
      const id = player.id || player.username;
      const gamesRes = http.get(`${BASE_URL}/users/${id}/games?take=1`, {
        tags: { name: 'find_active_game' },
      });
      if (gamesRes.status === 200) {
        const gamesData = JSON.parse(gamesRes.body);
        const games = gamesData.data || gamesData;
        if (Array.isArray(games) && games.length > 0) {
          const game = games[0];
          if (game.status === 'active') return game.id;
        }
      }
    }
  } catch { /* ignore */ }

  return null;
}
