import type { AssistantFeature } from './types.js';

export const play: AssistantFeature = {
  id: 'play',
  title: 'Play (matchmaking and bot)',
  paths: ['/play'],
  summary:
    'Primary screen for starting a game: matchmaking against real players or play against the Stockfish bot, configured side by side.',
  auth: 'user',
  featureFlag: null,
  mcpSection: null,
};
