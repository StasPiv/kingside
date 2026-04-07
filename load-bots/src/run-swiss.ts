#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Metrics } from './metrics.js';
import { runSwissScenario } from './scenarios/swiss.js';

async function main() {
  const config = loadConfig();
  const metrics = new Metrics();

  console.log(`Load Bots — Swiss Tournament`);
  console.log(`Target: ${config.baseUrl}`);
  console.log(`Bots: ${Math.min(config.concurrency, 32)}`);
  console.log('---');

  metrics.startPeriodicReport(10);

  try {
    await runSwissScenario(config, metrics);
  } finally {
    metrics.stopPeriodicReport();
    console.log('--- Final ---');
    metrics.report();
  }
}

main().catch(console.error);
