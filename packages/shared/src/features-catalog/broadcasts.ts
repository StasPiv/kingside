import type { AssistantFeature } from './types.js';

export const broadcasts: AssistantFeature = {
  id: 'broadcasts',
  title: 'Broadcasts',
  paths: [
    '/broadcasts',
    '/broadcasts/:tournamentId',
    '/broadcasts/:tournamentId/:roundId',
    '/broadcasts/:tournamentId/:roundId/:gameId',
    '/broadcasts/:tournamentId/:roundId/:gameId/live',
  ],
  summary:
    'Live relay of major chess events (FIDE Candidates, World Championship, Olympiad, etc.) sourced from the Lichess broadcast integration.',
  auth: 'public',
  featureFlag: 'broadcastsEnabled',
  mcpSection: null,
};
