import type { AssistantFeature } from './types.js';

export const workshop: AssistantFeature = {
  id: 'workshop',
  title: 'Workshop',
  paths: ['/workshop', '/workshop/pgn-files', '/workshop/pgn-files/:fileId'],
  summary:
    'Personal library of saved analyses and uploaded PGN files, with browsing of individual games inside each file.',
  auth: 'user',
  featureFlag: null,
  mcpSection: 'workshop',
};
