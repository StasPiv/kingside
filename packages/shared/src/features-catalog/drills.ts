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
    'Focused tactical trainers grouped by drill type (mating patterns, endgames, calculation), plus a Sprint mode with a leaderboard.',
  auth: 'optional',
  featureFlag: 'drillsEnabled',
  adr: ['ADR-035'],
  mcpSection: 'tactic_drills',
};
