import type { AssistantFeature } from './types.js';

export const puzzles: AssistantFeature = {
  id: 'puzzles',
  title: 'Puzzles',
  paths: ['/puzzles', '/puzzle', '/puzzle/:id', '/puzzles/stats'],
  summary:
    'Classic tactical puzzles set sourced from Lichess; solving updates a per-user puzzle rating (Glicko-2) and a streak. The newer engine-generated training lives separately on /precision.',
  auth: 'optional',
  featureFlag: 'puzzlesEnabled',
  mcpSection: 'puzzles',
};
