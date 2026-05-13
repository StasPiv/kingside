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
    'Live relay of major chess events (FIDE Candidates, World Championship, Olympiad, etc.). Shows real-time board positions, player info, and tournament metadata. Source is the Lichess broadcast integration. Broadcasts are marked as "LIVE" or "Archived".',
  highlights: [
    'Broadcasts lobby at {siteUrl}/broadcasts — list of live and archived broadcasts',
    'Tournament view at {siteUrl}/broadcasts/:tournamentId — overview of all rounds in a broadcast tournament',
    'Round view at {siteUrl}/broadcasts/:tournamentId/:roundId — board grid for a specific round',
    'Game view at {siteUrl}/broadcasts/:tournamentId/:roundId/:gameId — single board with move list and player info',
    'Live game view at {siteUrl}/broadcasts/:tournamentId/:roundId/:gameId/live — real-time view of an ongoing broadcast game',
  ],
  auth: 'public',
  featureFlag: 'broadcastsEnabled',
  mcpSection: null,
};
