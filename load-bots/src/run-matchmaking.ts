#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Metrics } from './metrics.js';
import { runMatchmakingScenario } from './scenarios/matchmaking-game.js';

async function main() {
  const config = loadConfig();
  const metrics = new Metrics();

  console.log(`Load Bots — Matchmaking + Game`);
  console.log(`Target: ${config.baseUrl}`);
  console.log(`Concurrency: ${config.concurrency} pairs, Duration: ${config.durationSec}s`);
  console.log(`Think time: ${config.thinkTimeMs[0]}-${config.thinkTimeMs[1]}ms`);
  console.log('---');

  metrics.startPeriodicReport(10);

  try {
    await runMatchmakingScenario(config, metrics);
  } finally {
    metrics.stopPeriodicReport();
    console.log('--- Final ---');
    metrics.report();
  }
}

main().catch(console.error);
