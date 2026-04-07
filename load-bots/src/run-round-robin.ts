#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Metrics } from './metrics.js';
import { runRoundRobinScenario } from './scenarios/round-robin.js';

async function main() {
  const config = loadConfig();
  const metrics = new Metrics();

  console.log(`Load Bots — Round Robin Tournament`);
  console.log(`Target: ${config.baseUrl}`);
  console.log(`Bots: ${Math.min(config.concurrency, 32)}`);
  console.log('---');

  metrics.startPeriodicReport(10);

  try {
    await runRoundRobinScenario(config, metrics);
  } finally {
    metrics.stopPeriodicReport();
    console.log('--- Final ---');
    metrics.report();
  }
}

main().catch(console.error);
