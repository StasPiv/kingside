import type { AssistantFeature } from './types.js';

export const precision: AssistantFeature = {
  id: 'precision',
  title: 'Precision Training',
  paths: [
    '/precision',
    '/precision/stats',
    '/precision/history',
    '/precision/attempts/:id',
  ],
  summary:
    '5-star training on engine-generated puzzles in two genres (realize the advantage / hold the draw), measuring WDL-loss vs the engine on each user move; tracks per-attempt stars and history.',
  auth: 'user',
  featureFlag: 'puzzlesEnabled',
  adr: [
    'ADR-047',
    'ADR-048',
    'ADR-055',
    'ADR-056',
    'ADR-057',
    'ADR-065',
    'ADR-066',
    'ADR-068',
    'ADR-069',
    'ADR-070',
  ],
  mcpSection: 'puzzles',
};
