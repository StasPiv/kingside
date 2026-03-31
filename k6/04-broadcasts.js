// k6/04-broadcasts.js — Broadcast spectators (WebSocket)
// Simulates users subscribing to broadcast rounds and receiving move updates.
//
// Usage:
//   k6 run k6/04-broadcasts.js
//   k6 run -e PROFILE=load k6/04-broadcasts.js
//   k6 run -e PROFILE=stress k6/04-broadcasts.js
//   k6 run -e BASE_URL=https://kingside.site/api k6/04-broadcasts.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import ws from 'k6/ws';
import { BASE_URL, WS_URL, profiles } from './config.js';

const profile = profiles[__ENV.PROFILE || 'smoke'];

// Broadcasts have many viewers — scale up
const viewerMultiplier = 10;
const scaledProfile = profile.stages
  ? {
      stages: profile.stages.map((s) => ({
        duration: s.duration,
        target: s.target * viewerMultiplier,
      })),
    }
  : { vus: profile.vus * viewerMultiplier, duration: profile.duration };

export const options = {
  scenarios: {
    broadcast_viewers: {
      executor: scaledProfile.stages ? 'ramping-vus' : 'constant-vus',
      ...(scaledProfile.stages
        ? { stages: scaledProfile.stages }
        : { vus: scaledProfile.vus, duration: scaledProfile.duration }),
    },
  },
  thresholds: {
    ...profile.thresholds,
    ws_connecting: ['p(95)<3000'],
    broadcast_sync_latency: ['p(95)<3000'],
    broadcast_events: ['count>0'],
  },
};

const syncLatency = new Trend('broadcast_sync_latency', true);
const broadcastEvents = new Counter('broadcast_events');
const connectErrors = new Counter('broadcast_connect_errors');

export default function () {
  // Step 1: Find an active broadcast round via REST
  const roundId = findOngoingRound();
  if (!roundId) {
    sleep(5);
    return;
  }

  // Step 2: Connect to broadcast WebSocket namespace
  const broadcastUrl = `${WS_URL}/broadcast`;
  const connectStart = Date.now();

  ws.connect(broadcastUrl, {}, function (socket) {
    let syncReceived = false;

    socket.on('open', () => {
      socket.send(JSON.stringify({
        event: 'broadcast:subscribe',
        data: { roundId },
      }));
    });

    socket.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);
        const event = parsed.event || parsed[0];

        if (event === 'broadcast:sync') {
          if (!syncReceived) {
            syncLatency.add(Date.now() - connectStart);
            syncReceived = true;
          }
          broadcastEvents.add(1);
        }

        if (event === 'broadcast:move') {
          broadcastEvents.add(1);
        }
      } catch { /* ignore */ }
    });

    socket.on('error', () => {
      connectErrors.add(1);
    });

    // Watch broadcast for 30-90s
    const watchDuration = 30000 + Math.random() * 60000;
    socket.setTimeout(() => {
      // Unsubscribe before closing
      socket.send(JSON.stringify({
        event: 'broadcast:unsubscribe',
        data: { roundId },
      }));
      socket.close();
    }, watchDuration);
  });

  sleep(1);
}

/**
 * Find an ongoing broadcast round via REST API.
 * Returns internal roundId (UUID) or null.
 */
function findOngoingRound() {
  const listRes = http.get(`${BASE_URL}/broadcasts?take=5`, {
    tags: { name: 'list_broadcasts' },
  });

  if (listRes.status !== 200) return null;

  try {
    const list = JSON.parse(listRes.body);
    const broadcasts = list.data || list;
    if (!Array.isArray(broadcasts) || broadcasts.length === 0) return null;

    // Check each broadcast for an ongoing round
    for (const bc of broadcasts) {
      const roundsRes = http.get(`${BASE_URL}/broadcasts/${bc.id}/rounds`, {
        tags: { name: 'list_rounds' },
      });
      if (roundsRes.status !== 200) continue;

      const roundsData = JSON.parse(roundsRes.body);
      const rounds = roundsData.data || roundsData;
      if (!Array.isArray(rounds)) continue;

      const ongoing = rounds.find((r) => r.status === 'ongoing');
      if (ongoing) return ongoing.id;

      // Fallback: use latest finished round for testing
      const finished = rounds.filter((r) => r.status === 'finished');
      if (finished.length > 0) return finished[finished.length - 1].id;
    }
  } catch { /* ignore */ }

  return null;
}
