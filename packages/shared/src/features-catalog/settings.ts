import type { AssistantFeature } from './types.js';

export const settings: AssistantFeature = {
  id: 'settings',
  title: 'Settings',
  paths: ['/settings'],
  summary:
    'Account settings: language, board appearance, animation speed, external account linking, blocked users.',
  highlights: [
    'Language: English or Russian',
    'Board theme: default, green, blue, brown',
    'Piece set: standard, cburnett, alpha, merida',
    'Piece animation speed',
    'External accounts: link Chess.com and Lichess usernames',
    'Blocked users management',
  ],
  caveats: ['Requires authentication'],
  auth: 'user',
  featureFlag: null,
  mcpSection: null,
};
