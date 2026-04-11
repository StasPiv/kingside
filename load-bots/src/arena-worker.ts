/**
 * Arena bot worker — runs inside a worker_thread.
 * Receives: tournamentId, bot range, config.
 * Reports: metrics via parentPort.
 */
import { parentPort, workerData } from 'worker_threads';
import { BotUser } from './bot-user.js';
import { ChessBrain } from './chess-brain.js';
import { Metrics } from './metrics.js';
import { Config } from './config.js';

interface WorkerInput {
  tournamentId: string;
  botStartIndex: number;
  botCount: number;
  config: Config;
  durationMin: number;
  timeInitialSec: number;
}

const input = workerData as WorkerInput;
const metrics = new Metrics();

// Report metrics to main thread every 10s
const metricsInterval = setInterval(() => {
  parentPort?.postMessage({ type: 'metrics', data: metrics.snapshot() });
}, 10_000);

async function run() {
  const { tournamentId, botStartIndex, botCount, config, durationMin } = input;
  const prefix = config.userPrefix || 'loadbot';

  // Create and login bots
  const bots: BotUser[] = [];
  for (let i = 0; i < botCount; i++) {
    const bot = new BotUser(config.baseUrl, config.wsUrl, `${prefix}T${botStartIndex + i}`, metrics);
    await bot.login(config.devBypassSecret);
    bots.push(bot);
  }

  // Join tournament
  for (const bot of bots) {
    try {
      await bot.post(`/api/arena/${tournamentId}/join`, {});
    } catch {
      metrics.recordError();
    }
  }

  parentPort?.postMessage({ type: 'log', msg: `Worker: ${botCount} bots joined (T${botStartIndex}-T${botStartIndex + botCount - 1})` });

  // Import arena scenario and run bots
  const { runBotInArenaExported } = await import('./scenarios/arena.js');
  const promises = bots.map((bot) => runBotInArenaExported(bot, tournamentId, config, metrics, durationMin));
  await Promise.all(promises);

  // Final metrics
  parentPort?.postMessage({ type: 'metrics', data: metrics.snapshot() });
  parentPort?.postMessage({ type: 'done' });

  bots.forEach((b) => b.disconnect());
  clearInterval(metricsInterval);
}

run().catch((e) => {
  parentPort?.postMessage({ type: 'error', msg: e.message });
  clearInterval(metricsInterval);
});
