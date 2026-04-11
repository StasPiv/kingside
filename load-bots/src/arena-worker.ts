/**
 * Arena bot worker — runs as separate tsx process.
 * Receives config via WORKER_DATA env var.
 * Reports via stdout.
 */
import { BotUser } from './bot-user.js';
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

const input = JSON.parse(process.env.WORKER_DATA || '{}') as WorkerInput;
const metrics = new Metrics();
metrics.startPeriodicReport(10);

async function run() {
  const { tournamentId, botStartIndex, botCount, config, durationMin } = input;
  const prefix = config.userPrefix || 'loadbot';

  const bots: BotUser[] = [];
  for (let i = 0; i < botCount; i++) {
    const bot = new BotUser(config.baseUrl, config.wsUrl, `${prefix}T${botStartIndex + i}`, metrics);
    await bot.login(config.devBypassSecret);
    bots.push(bot);
  }

  for (const bot of bots) {
    try {
      await bot.post(`/api/arena/${tournamentId}/join`, {});
    } catch {
      metrics.recordError();
    }
  }

  console.log(`${botCount} bots joined (T${botStartIndex}-T${botStartIndex + botCount - 1})`);

  const { runBotInArenaExported } = await import('./scenarios/arena.js');
  const promises = bots.map((bot) => runBotInArenaExported(bot, tournamentId, config, metrics, durationMin));
  await Promise.all(promises);

  metrics.stopPeriodicReport();
  metrics.report();
  bots.forEach((b) => b.disconnect());
}

run().catch((e) => {
  console.error(`Worker error: ${e.message}`);
  process.exit(1);
});
