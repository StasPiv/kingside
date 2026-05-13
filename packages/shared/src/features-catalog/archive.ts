import type { AssistantFeature } from './types.js';

export const archive: AssistantFeature = {
  id: 'archive',
  title: 'Archive (external games and players)',
  paths: ['/archive', '/archive/games/:id', '/archive/players/:slug'],
  summary:
    'Searchable archive of professional/master-level tournament games imported weekly from TWIC (The Week In Chess), with filters by player, opening, position.',
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
