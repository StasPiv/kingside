#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Metrics } from './metrics.js';
import { runArenaScenario } from './scenarios/arena.js';

async function main() {
  const config = loadConfig();
  const metrics = new Metrics();

  console.log(`Load Bots — Arena Tournament`);
  console.log(`Target: ${config.baseUrl}`);
  console.log(`Bots: ${Math.min(config.concurrency, 32)}, Duration: ${config.durationSec}s`);
  console.log('---');

  metrics.startPeriodicReport(10);

  try {
    await runArenaScenario(config, metrics);
  } finally {
    metrics.stopPeriodicReport();
    console.log('--- Final ---');
    metrics.report();
  }
}

main().catch(console.error);
