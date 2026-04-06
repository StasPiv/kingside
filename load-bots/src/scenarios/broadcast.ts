import { io, Socket } from 'socket.io-client';
import { BotUser } from '../bot-user.js';
import { Metrics } from '../metrics.js';
import { Config } from '../config.js';

/**
 * Broadcast fan-out: N bots subscribe to an ongoing broadcast round.
 * Measures: how many viewers receive sync/move events.
 */
export async function runBroadcastScenario(config: Config, metrics: Metrics): Promise<void> {
  const viewerCount = config.concurrency;
  console.log(`[Broadcast] ${viewerCount} viewers for ${config.durationSec}s`);

  // Find an ongoing broadcast round
  const bot = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}Br0`, metrics);
  const roundId = await findOngoingRound(bot, config);

  if (!roundId) {
    console.log('[Broadcast] No ongoing round found, trying any round...');
    const anyRound = await findAnyRound(bot, config);
    if (!anyRound) {
      console.log('[Broadcast] No rounds at all. Aborting.');
      return;
    }
    return runWithRound(anyRound, viewerCount, config, metrics);
  }

  await runWithRound(roundId, viewerCount, config, metrics);
}

async function runWithRound(
  roundId: string,
  viewerCount: number,
  config: Config,
  metrics: Metrics,
): Promise<void> {
  console.log(`[Broadcast] Subscribing ${viewerCount} viewers to round ${roundId}`);

  const viewers: Socket[] = [];
  let syncsReceived = 0;
  let movesReceived = 0;

  for (let i = 0; i < viewerCount; i++) {
    const socket = io(`${config.wsUrl}/broadcast`, {
      transports: ['websocket'],
      reconnection: false,
    });

    socket.on('connect', () => {
      socket.emit('broadcast:subscribe', { roundId });
    });

    socket.on('broadcast:sync', () => {
      syncsReceived++;
      metrics.recordLatency(0); // sync is instant
    });

    socket.on('broadcast:move', () => {
      movesReceived++;
      metrics.recordMove();
    });

    viewers.push(socket);

    // Stagger connections
    if (i % 20 === 19) await sleep(100);
  }

  await sleep(1000);
  const connected = viewers.filter((s) => s.connected).length;
  console.log(`[Broadcast] ${connected}/${viewerCount} connected`);

  // Wait for duration
  const waitMs = Math.min(config.durationSec * 1000, 60_000);
  await sleep(waitMs);

  console.log(`[Broadcast] Done. syncs=${syncsReceived} moves=${movesReceived} connected=${viewers.filter((s) => s.connected).length}`);

  // Cleanup
  for (const s of viewers) {
    s.emit('broadcast:unsubscribe', { roundId });
    s.disconnect();
  }
}

async function findOngoingRound(bot: BotUser, config: Config): Promise<string | null> {
  try {
    const res = await fetch(`${config.baseUrl}/api/broadcasts?take=5`);
    if (!res.ok) return null;
    const list = (await res.json()) as { data: { id: string }[] };

    for (const bc of list.data) {
      const rRes = await fetch(`${config.baseUrl}/api/broadcasts/${bc.id}/rounds`);
      if (!rRes.ok) continue;
      const rounds = (await rRes.json()) as { data: { id: string; status: string }[] };
      const ongoing = rounds.data.find((r) => r.status === 'ongoing');
      if (ongoing) return ongoing.id;
    }
  } catch { /* */ }
  return null;
}

async function findAnyRound(bot: BotUser, config: Config): Promise<string | null> {
  try {
    const res = await fetch(`${config.baseUrl}/api/broadcasts?take=3`);
    if (!res.ok) return null;
    const list = (await res.json()) as { data: { id: string }[] };

    for (const bc of list.data) {
      const rRes = await fetch(`${config.baseUrl}/api/broadcasts/${bc.id}/rounds`);
      if (!rRes.ok) continue;
      const rounds = (await rRes.json()) as { data: { id: string }[] };
      if (rounds.data.length > 0) return rounds.data[rounds.data.length - 1].id;
    }
  } catch { /* */ }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
