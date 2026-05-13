import type { AssistantFeature } from './types.js';

export const players: AssistantFeature = {
  id: 'players',
  title: 'Players',
  paths: ['/players', '/player/:username'],
  summary:
    'Player directory and public player profiles. Search any player by username and view their ratings, online status, and game history.',
  highlights: [
    'Player directory at {siteUrl}/players — search by username, browse the user base',
    'Public profile at {siteUrl}/player/:username — username, join date, online status, ratings for all time controls (bullet, blitz, rapid, classical, puzzle), game history',
  ],
  auth: 'public',
  featureFlag: null,
  mcpSection: 'players',
};
