import type { AssistantFeature } from './types.js';

export const puzzles: AssistantFeature = {
  id: 'puzzles',
  title: 'Puzzles',
  paths: ['/puzzles', '/puzzle', '/puzzle/:id', '/puzzles/stats'],
  summary:
    'Tactical puzzles to improve pattern recognition. Each puzzle has a position (FEN) and a solution (sequence of moves). The system selects puzzles matching the user\'s puzzle rating (±200). After solving, a new puzzle loads automatically.',
  highlights: [
    'Puzzle browser at {siteUrl}/puzzles — pick by theme, difficulty, or just start the daily mix',
    'Single puzzle screen at {siteUrl}/puzzle or {siteUrl}/puzzle/:id — solve interactively',
    'Themes: fork, pin, skewer, mate (mate-in-1, mate-in-2, etc.), discovered attack, sacrifice, endgame, promotion, and many more (50+ themes)',
    'Rating: each puzzle has its own rating. Solving raises the user\'s puzzle rating; failing lowers it (Glicko-2 system)',
    'Streak: consecutive correct solves tracked as a streak counter',
    'Alternative moves: if the user\'s move is close in evaluation to the main line (within 50 centipawns), it is accepted as a "good alternative" — the system shows a message and continues on the main solution line',
    'Generated puzzles: auto-generated from users\' own games. No setup move — the user plays from the position directly. Some accept multiple first moves',
    'Statistics at {siteUrl}/puzzles/stats — puzzle rating graph over time, total solved/attempted, solve rate, current streak, average solve time, and per-theme breakdown (strong/weak themes)',
    'Retry: if the user fails, they can retry the same puzzle',
  ],
  caveats: [
    'Requires authentication for rating updates and history; anonymous puzzles available read-only',
  ],
  auth: 'optional',
  featureFlag: 'puzzlesEnabled',
  mcpSection: 'puzzles',
};
