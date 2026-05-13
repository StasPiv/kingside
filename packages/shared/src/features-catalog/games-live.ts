import type { AssistantFeature } from './types.js';

export const gamesLive: AssistantFeature = {
  id: 'games-live',
  title: 'Watch live games',
  paths: ['/games/live', '/games/:id/watch'],
  summary:
    'Spectator lobby and per-game read-only board for watching games currently in progress on the platform.',
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
