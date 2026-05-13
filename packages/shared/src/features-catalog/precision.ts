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
    'Training that measures move accuracy in centipawn loss against engine evaluation on user-uploaded positions or the user\'s own games.',
  auth: 'user',
  featureFlag: 'puzzlesEnabled',
  adr: ['ADR-047', 'ADR-048', 'ADR-055', 'ADR-056', 'ADR-057'],
  mcpSection: 'puzzles',
};
