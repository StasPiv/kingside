import type { AssistantFeature } from './types.js';

export const puzzles: AssistantFeature = {
  id: 'puzzles',
  title: 'Puzzles',
  paths: ['/puzzles', '/puzzle', '/puzzle/:id', '/puzzles/stats'],
  summary:
    'Tactical puzzles selected near the user\'s puzzle rating; solving updates a Glicko-2 puzzle rating and streak counter.',
  auth: 'optional',
  featureFlag: 'puzzlesEnabled',
  mcpSection: 'puzzles',
};
