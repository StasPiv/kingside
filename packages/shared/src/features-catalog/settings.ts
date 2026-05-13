import type { AssistantFeature } from './types.js';

export const settings: AssistantFeature = {
  id: 'settings',
  title: 'Settings',
  paths: ['/settings'],
  summary:
    'Account settings: profile basics, language, board appearance, piece animation speed, sound options, external account linking, blocked users, drills onboarding reset.',
  highlights: [
    'Profile block: username, email, puzzle rating (displayed at the top of the page)',
    'Language: English or Russian',
    'Board theme: default, green, blue, brown',
    'Piece set: standard, cburnett, alpha, merida',
    'Piece animation speed: none / fast / normal (0 ms / 100 ms / 200 ms)',
    'Sound options for in-game events',
    'External accounts: link Chess.com and Lichess usernames (display-only — no game import)',
    'Drills onboarding reset — replay the intro tutorial on the Drills page',
    'Blocked users management',
  ],
  caveats: ['Requires authentication'],
  auth: 'user',
  featureFlag: null,
  mcpSection: null,
};
