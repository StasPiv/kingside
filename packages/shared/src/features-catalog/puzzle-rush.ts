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
    'Speed-solving puzzle mode. Choose a 3-minute or 5-minute timer and solve as many puzzles as possible. 3 lives — each wrong answer costs one life. Session ends when time runs out or all lives are lost. Score = number of puzzles solved.',
  highlights: [
    'Play screen at {siteUrl}/puzzle-rush — start a new session, pick timer 3 or 5 minutes',
    'Leaderboard at {siteUrl}/puzzle-rush/leaderboard — global ranking by best score',
    'Per-session review at {siteUrl}/puzzle-rush/review/:scoreId — go through which puzzles were solved and which were missed',
  ],
  caveats: [
    'Requires authentication to record scores; leaderboard is public',
  ],
  auth: 'optional',
  featureFlag: null,
  mcpSection: 'puzzle_rush',
};
