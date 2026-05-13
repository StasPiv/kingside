import type { AssistantFeature } from './types.js';

export const drills: AssistantFeature = {
  id: 'drills',
  title: 'Drills (tactical trainers)',
  paths: [
    '/drills',
    '/drills/about',
    '/drills/sprint',
    '/drills/sprint/play',
    '/drills/sprint/results',
    '/drills/sprint/leaderboard',
    '/drills/:type',
  ],
  summary:
    'Focused tactical trainers organized by drill type (mating patterns, endgame techniques, calculation, etc.). Each drill is a short timed exercise with a specific goal. Sprint mode chains drills back-to-back with a global timer and leaderboard.',
  highlights: [
    'Drills lobby at {siteUrl}/drills — pick a drill type to start',
    'About at {siteUrl}/drills/about — explanation of drill formats and what each trains',
    'Single drill type at {siteUrl}/drills/:type — practice one type continuously',
    'Sprint setup at {siteUrl}/drills/sprint — configure a sprint session (drill mix, duration)',
    'Sprint play at {siteUrl}/drills/sprint/play — solve drills against the clock',
    'Sprint results at {siteUrl}/drills/sprint/results — score breakdown of the last sprint',
    'Sprint leaderboard at {siteUrl}/drills/sprint/leaderboard — top sprint scores across users',
  ],
  caveats: [
    'Requires authentication to record results and appear on the leaderboard',
  ],
  auth: 'optional',
  featureFlag: 'drillsEnabled',
  adr: ['ADR-035'],
  mcpSection: 'tactic_drills',
};
