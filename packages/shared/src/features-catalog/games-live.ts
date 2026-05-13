import type { AssistantFeature } from './types.js';

export const gamesLive: AssistantFeature = {
  id: 'games-live',
  title: 'Watch live games',
  paths: ['/games/live', '/games/:id/watch'],
  summary:
    'Spectate games currently in progress on the platform. The lobby lists active games; clicking a game opens a read-only board with the live position and move list.',
  highlights: [
    'Lobby at {siteUrl}/games/live — list of all active games on the platform with players, ratings, and time control',
    'Per-game spectate view at {siteUrl}/games/:id/watch — live board updates, move list, and clocks; no interaction',
  ],
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
