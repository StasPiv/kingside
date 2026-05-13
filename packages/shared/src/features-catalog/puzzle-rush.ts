import type { AssistantFeature } from './types.js';

export const puzzleRush: AssistantFeature = {
  id: 'puzzle-rush',
  title: 'Puzzle Rush',
  paths: [
    '/puzzle-rush',
    '/puzzle-rush/leaderboard',
    '/puzzle-rush/review/:scoreId',
  ],
  summary:
    'Speed-solving mode where the user solves as many puzzles as possible against a 3-minute or 5-minute timer with three lives.',
  auth: 'optional',
  featureFlag: null,
  mcpSection: 'puzzle_rush',
};
