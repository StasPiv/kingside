import type { AssistantFeature } from './types.js';

export const activeGame: AssistantFeature = {
  id: 'active-game',
  title: 'Active game and post-game review',
  paths: ['/game/:id', '/game/:gameId/review'],
  summary:
    'Interactive board for a live game in progress, plus the dedicated post-game review screen that opens after the game ends.',
  highlights: [
    'Live game at {siteUrl}/game/:id — drag-and-drop or click-to-move, clocks, move list, captured pieces. Players can offer a draw, resign, or request a takeback',
    'Post-game review at {siteUrl}/game/:gameId/review — replay the game move by move with Stockfish evaluation, move classification (best / good / inaccuracy / mistake / blunder), and accuracy summary. Available for both human and bot games',
  ],
  auth: 'optional',
  featureFlag: null,
  mcpSection: null,
};
