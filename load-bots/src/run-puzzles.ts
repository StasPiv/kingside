#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Metrics } from './metrics.js';
import { runPuzzleScenario, runPuzzleRushScenario } from './scenarios/puzzle.js';

const mode = process.argv[2] || 'puzzles'; // puzzles | rush | both

async function main() {
  const config = loadConfig();
  const metrics = new Metrics();

  console.log(`Load Bots — ${mode === 'rush' ? 'Puzzle Rush' : mode === 'both' ? 'Puzzles + Rush' : 'Puzzles'}`);
  console.log(`Target: ${config.baseUrl}`);
  console.log(`Concurrency: ${config.concurrency}, Duration: ${config.durationSec}s`);
  console.log('---');

  metrics.startPeriodicReport(10);

  try {
    if (mode === 'rush') {
      await runPuzzleRushScenario(config, metrics);
    } else if (mode === 'both') {
      await Promise.all([
        runPuzzleScenario(config, metrics),
        runPuzzleRushScenario(config, metrics),
      ]);
    } else {
      await runPuzzleScenario(config, metrics);
    }
  } finally {
    metrics.stopPeriodicReport();
    console.log('--- Final ---');
    metrics.report();
  }
}

main().catch(console.error);
