import type { AssistantFeature } from './types.js';

export const players: AssistantFeature = {
  id: 'players',
  title: 'Players',
  paths: ['/players', '/player/:username'],
  summary:
    'Player directory and public player profiles with username search, ratings per time control, online status, and game history.',
  auth: 'public',
  featureFlag: null,
  mcpSection: 'players',
};
