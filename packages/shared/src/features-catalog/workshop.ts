import type { AssistantFeature } from './types.js';

export const workshop: AssistantFeature = {
  id: 'workshop',
  title: 'Workshop',
  paths: ['/workshop', '/workshop/pgn-files', '/workshop/pgn-files/:fileId'],
  summary:
    'Personal library of saved work: analyses you have saved from the analysis board, and PGN files you have uploaded for browsing and analyzing games inside them.',
  highlights: [
    'My Analyses at {siteUrl}/workshop — analyses saved from the Analysis page. Click to reopen and continue analysis',
    'PGN Files at {siteUrl}/workshop/pgn-files — upload PGN files containing multiple games',
    'Browse inside a file at {siteUrl}/workshop/pgn-files/:fileId — list games inside the file, select any game to analyze it',
  ],
  caveats: [
    'Requires authentication',
  ],
  auth: 'user',
  featureFlag: null,
  mcpSection: 'workshop',
};
