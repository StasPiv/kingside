#!/usr/bin/env node
/**
 * Unified runner for all load bot scenarios with preset profiles.
 *
 * Usage:
 *   npx ts-node src/run.ts smoke          # 2 pairs, 30s
 *   npx ts-node src/run.ts load           # 50 pairs, 5 min
 *   npx ts-node src/run.ts stress         # 200 pairs, 5 min
 *   npx ts-node src/run.ts soak           # 50 pairs, 30 min
 *   npx ts-node src/run.ts fan-out        # 2 players + 200 spectators
 *   npx ts-node src/run.ts tournament     # 16 bots arena
 *   npx ts-node src/run.ts all            # smoke of everything
 *
 * Env overrides: BASE_URL, WS_URL, DEV_BYPASS_SECRET
 */

import { Metrics } from './metrics.js';
import { Config, loadConfig } from './config.js';
import { runMatchmakingScenario } from './scenarios/matchmaking-game.js';
import { runPuzzleScenario, runPuzzleRushScenario } from './scenarios/puzzle.js';
import { runSpectatorScenario } from './scenarios/spectator.js';
import { runBroadcastScenario } from './scenarios/broadcast.js';
import { runArenaScenario } from './scenarios/arena.js';

interface Profile {
  name: string;
  concurrency: number;
  durationSec: number;
  thinkTimeMs: [number, number];
  scenarios: string[];
}

const PROFILES: Record<string, Profile> = {
  smoke: {
    name: 'Smoke Test',
    concurrency: 2,
    durationSec: 30,
    thinkTimeMs: [300, 1000],
    scenarios: ['matchmaking', 'puzzles'],
  },
  load: {
    name: 'Load Test',
    concurrency: 50,
    durationSec: 300,
    thinkTimeMs: [500, 2000],
    scenarios: ['matchmaking', 'puzzles', 'spectator'],
  },
  stress: {
    name: 'Stress Test',
    concurrency: 200,
    durationSec: 300,
    thinkTimeMs: [200, 1000],
    scenarios: ['matchmaking', 'puzzles', 'spectator', 'broadcast'],
  },
  soak: {
    name: 'Soak Test',
    concurrency: 50,
    durationSec: 1800,
    thinkTimeMs: [1000, 3000],
    scenarios: ['matchmaking', 'puzzles'],
  },
  'fan-out': {
    name: 'Fan-out Test',
    concurrency: 200,
    durationSec: 120,
    thinkTimeMs: [1000, 3000],
    scenarios: ['spectator', 'broadcast'],
  },
  tournament: {
    name: 'Tournament Test',
    concurrency: 16,
    durationSec: 300,
    thinkTimeMs: [300, 1500],
    scenarios: ['arena'],
  },
  all: {
    name: 'Full Smoke (all scenarios)',
    concurrency: 2,
    durationSec: 60,
    thinkTimeMs: [300, 1000],
    scenarios: ['matchmaking', 'puzzles', 'puzzle-rush', 'spectator', 'broadcast', 'arena'],
  },
};

const SCENARIO_RUNNERS: Record<string, (cfg: Config, m: Metrics) => Promise<void>> = {
  matchmaking: runMatchmakingScenario,
  puzzles: runPuzzleScenario,
  'puzzle-rush': runPuzzleRushScenario,
  spectator: runSpectatorScenario,
  broadcast: runBroadcastScenario,
  arena: runArenaScenario,
};

async function main() {
  const profileName = process.argv[2] || 'smoke';
  const profile = PROFILES[profileName];

  if (!profile) {
    console.error(`Unknown profile: ${profileName}`);
    console.error(`Available: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(1);
  }

  const baseConfig = loadConfig();
  const config: Config = {
    ...baseConfig,
    concurrency: profile.concurrency,
    durationSec: profile.durationSec,
    thinkTimeMs: profile.thinkTimeMs,
  };

  const metrics = new Metrics();

  console.log(`╔══════════════════════════════════════╗`);
  console.log(`║  Load Bots — ${profile.name.padEnd(24)}║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Target:      ${config.baseUrl.padEnd(22)}║`);
  console.log(`║  Concurrency: ${String(config.concurrency).padEnd(22)}║`);
  console.log(`║  Duration:    ${(config.durationSec + 's').padEnd(22)}║`);
  console.log(`║  Think:       ${(config.thinkTimeMs[0] + '-' + config.thinkTimeMs[1] + 'ms').padEnd(22)}║`);
  console.log(`║  Scenarios:   ${profile.scenarios.join(', ').padEnd(22)}║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log('');

  metrics.startPeriodicReport(10);
  const startTime = Date.now();

  try {
    // Run scenarios sequentially for smoke/all, parallel for load/stress
    if (profileName === 'all' || profileName === 'smoke') {
      for (const scenario of profile.scenarios) {
        const runner = SCENARIO_RUNNERS[scenario];
        if (!runner) { console.warn(`Unknown scenario: ${scenario}`); continue; }
        console.log(`\n━━━ ${scenario} ━━━`);
        await runner(config, metrics);
      }
    } else {
      // Run all scenarios in parallel
      const promises = profile.scenarios.map((scenario) => {
        const runner = SCENARIO_RUNNERS[scenario];
        if (!runner) { console.warn(`Unknown scenario: ${scenario}`); return Promise.resolve(); }
        return runner(config, metrics);
      });
      await Promise.all(promises);
    }
  } finally {
    metrics.stopPeriodicReport();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║  Results (${elapsed}s elapsed)`.padEnd(39) + `║`);
    console.log(`╚══════════════════════════════════════╝`);
    metrics.report();
  }
}

main().catch(console.error);
