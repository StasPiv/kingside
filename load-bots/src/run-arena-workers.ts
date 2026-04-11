#!/usr/bin/env node
/**
 * Arena load test with worker_threads.
 * Main thread creates tournament, spawns workers with BOTS_PER_WORKER bots each.
 *
 * Usage:
 *   CONCURRENCY=100 BOTS_PER_WORKER=25 tsx src/run-arena-workers.ts
 */
import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { Metrics } from './metrics.js';
import { BotUser } from './bot-user.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  const totalBots = config.concurrency;
  const botsPerWorker = parseInt(process.env.BOTS_PER_WORKER || '25', 10);
  const workerCount = Math.ceil(totalBots / botsPerWorker);
  const durationMin = parseInt(process.env.ARENA_DURATION_MIN || '30', 10);
  const timeInitialSec = parseInt(process.env.TIME_INITIAL_SEC || '180', 10);

  console.log(`╔══════════════════════════════════════╗`);
  console.log(`║  Arena Workers                        ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Bots:        ${String(totalBots).padEnd(24)}║`);
  console.log(`║  Workers:     ${String(workerCount).padEnd(24)}║`);
  console.log(`║  Per worker:  ${String(botsPerWorker).padEnd(24)}║`);
  console.log(`║  Duration:    ${(durationMin + 'min').padEnd(24)}║`);
  console.log(`║  Time:        ${(timeInitialSec + 's').padEnd(24)}║`);
  console.log(`║  Target:      ${config.baseUrl.padEnd(24)}║`);
  console.log(`║  WS:          ${config.wsUrl.padEnd(24)}║`);
  console.log(`╚══════════════════════════════════════╝`);

  // Create tournament from main thread
  const bot0 = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}T0`, new Metrics());
  await bot0.login(config.devBypassSecret);

  const startsAt = new Date(Date.now() + 15_000).toISOString();
  let tournament: { id: string };
  try {
    tournament = await bot0.post<{ id: string }>('/api/arena', {
      name: `LoadBot Arena ${Date.now()}`,
      type: 'arena',
      timeInitialSec,
      timeIncrementSec: 0,
      durationMin,
      startsAt,
    });
  } catch (e: unknown) {
    console.error(`Failed to create tournament: ${(e as Error).message}`);
    bot0.disconnect();
    process.exit(1);
  }
  bot0.disconnect();

  console.log(`\nTournament ${tournament.id} created. Spawning ${workerCount} workers...\n`);

  // Aggregate metrics
  const aggregated = new Metrics();
  let doneCount = 0;
  const startTime = Date.now();

  // Metrics report interval
  const reportInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    aggregated.report();
    console.log(`  (${elapsed}s elapsed, ${doneCount}/${workerCount} workers done)`);
    aggregated.reset();
  }, 10_000);

  // Spawn workers
  const workerPromises: Promise<void>[] = [];

  for (let w = 0; w < workerCount; w++) {
    const botStart = w * botsPerWorker;
    const count = Math.min(botsPerWorker, totalBots - botStart);

    const workerPath = path.join(__dirname, 'arena-worker.ts');

    const promise = new Promise<void>((resolve, reject) => {
      const loadBotsRoot = path.resolve(__dirname, '..');
      const tsxBin = path.resolve(loadBotsRoot, '..', 'node_modules', '.bin', 'tsx');
      const worker = spawn(tsxBin, [workerPath], {
        cwd: loadBotsRoot,
        env: {
          ...process.env,
          WORKER_DATA: JSON.stringify({
            tournamentId: tournament.id,
            botStartIndex: botStart,
            botCount: count,
            config,
            durationMin,
            timeInitialSec,
          }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      worker.stdout.on('data', (chunk: Buffer) => process.stdout.write(`[W${w}] ${chunk}`));
      worker.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[W${w}] ${chunk}`));

      worker.on('error', (err) => {
        console.error(`[Worker${w}] Fatal: ${err.message}`);
        reject(err);
      });

      worker.on('exit', (code) => {
        doneCount++;
        console.log(`[Worker${w}] Done (${doneCount}/${workerCount}, exit=${code})`);
        resolve();
      });
    });

    workerPromises.push(promise);
    console.log(`[Worker${w}] Spawned: bots T${botStart}-T${botStart + count - 1}`);
  }

  await Promise.all(workerPromises);
  clearInterval(reportInterval);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Results (${elapsed}s)`.padEnd(39) + `║`);
  console.log(`╚══════════════════════════════════════╝`);
  aggregated.report();
}

main().catch(console.error);
