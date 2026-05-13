import type { AssistantFeature } from './types.js';

export const archive: AssistantFeature = {
  id: 'archive',
  title: 'Archive (external games and players)',
  paths: ['/archive', '/archive/games/:id', '/archive/players/:slug'],
  summary:
    'Searchable archive of professional/master-level tournament games imported weekly from TWIC (The Week In Chess). Useful for studying games by player, opening, or position. Not integrated with users\' personal Chess.com / Lichess accounts — those are not imported.',
  highlights: [
    'Archive search at {siteUrl}/archive — games sourced from weekly TWIC PGN bundles (tournament classical). Filters: player, event, ECO opening code, since/until dates, result, minElo, minPly, maxPly, sort; plus position search via ?fen= query',
    'Single archived game at {siteUrl}/archive/games/:id — full PGN with metadata, opens in the analysis board',
    'Archived player profile at {siteUrl}/archive/players/:slug — public view of an external player\'s archived games',
  ],
  caveats: [
    'Personal Chess.com / Lichess accounts are NOT imported into the archive — the chesscomUsername / lichessUsername fields in Settings are stored only on the profile',
  ],
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
