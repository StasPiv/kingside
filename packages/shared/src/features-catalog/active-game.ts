import type { AssistantFeature } from './types.js';

export const activeGame: AssistantFeature = {
  id: 'active-game',
  title: 'Active game and post-game review',
  paths: ['/game/:id', '/game/:gameId/review'],
  summary:
    'Live board for a game in progress and the post-game review screen that opens after the game ends (available for both human and bot games).',
  auth: 'optional',
  featureFlag: null,
  mcpSection: null,
};
