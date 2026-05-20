import type { AssistantFeature } from './types.js';

export const archive: AssistantFeature = {
  id: 'archive',
  title: 'Archive (external games and players)',
  paths: ['/archive', '/archive/games/:id', '/archive/players/:slug'],
  summary:
    'Searchable archive of professional/master-level tournament games imported weekly from TWIC, with filters by player and opening and a position search (paste a FEN or upload a board image).',
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
