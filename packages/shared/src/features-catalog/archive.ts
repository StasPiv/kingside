import type { AssistantFeature } from './types.js';

export const archive: AssistantFeature = {
  id: 'archive',
  title: 'Archive (external games and players)',
  paths: ['/archive', '/archive/games/:id', '/archive/players/:slug'],
  summary:
    'Searchable archive of games imported from external sources (Chess.com, Lichess). Useful for studying games of specific players or positions without leaving Kingside.',
  highlights: [
    'Archive search at {siteUrl}/archive — search games by player, time control, opening, or position',
    'Single archived game at {siteUrl}/archive/games/:id — full PGN with metadata, opens in the analysis board',
    'Archived player profile at {siteUrl}/archive/players/:slug — public view of an external player\'s archived games',
  ],
  auth: 'public',
  featureFlag: null,
  mcpSection: 'archive',
};
