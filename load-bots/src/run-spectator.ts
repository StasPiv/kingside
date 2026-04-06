#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Metrics } from './metrics.js';
import { runSpectatorScenario } from './scenarios/spectator.js';
import { runBroadcastScenario } from './scenarios/broadcast.js';

const mode = process.argv[2] || 'spectator'; // spectator | broadcast | both

async function main() {
  const config = loadConfig();
  const metrics = new Metrics();

  console.log(`Load Bots — ${mode === 'broadcast' ? 'Broadcast' : mode === 'both' ? 'Spectator + Broadcast' : 'Spectator'}`);
  console.log(`Target: ${config.baseUrl}`);
  console.log(`Concurrency: ${config.concurrency}, Duration: ${config.durationSec}s`);
  console.log('---');

  metrics.startPeriodicReport(10);

  try {
    if (mode === 'broadcast') {
      await runBroadcastScenario(config, metrics);
    } else if (mode === 'both') {
      await Promise.all([
        runSpectatorScenario(config, metrics),
        runBroadcastScenario(config, metrics),
      ]);
    } else {
      await runSpectatorScenario(config, metrics);
    }
  } finally {
    metrics.stopPeriodicReport();
    console.log('--- Final ---');
    metrics.report();
  }
}

main().catch(console.error);
