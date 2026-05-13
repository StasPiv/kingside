import type { AssistantFeature } from './types.js';

export const precision: AssistantFeature = {
  id: 'precision',
  title: 'Precision Training',
  paths: [
    '/precision',
    '/precision/stats',
    '/precision/history',
    '/precision/attempts/:id',
  ],
  summary:
    'Practice precision on user-uploaded positions and on positions from your own games. The system measures move accuracy against engine evaluation (centipawn loss) and tracks trends over time.',
  highlights: [
    'Main training screen at {siteUrl}/precision — pick a position pack and play through it move by move',
    'Statistics at {siteUrl}/precision/stats — accuracy %, ACPL (average centipawn loss), distribution of best/good/inaccuracy/mistake/blunder moves, per-pack and per-timeframe breakdowns',
    'History at {siteUrl}/precision/history — list of past attempts with filters and sorting',
    'Per-attempt review at {siteUrl}/precision/attempts/:id — replay an attempt move by move with engine evaluation',
  ],
  caveats: [
    'Requires authentication',
    'Engine evaluation runs on the server (Stockfish 18), not in the browser',
  ],
  auth: 'user',
  featureFlag: 'puzzlesEnabled',
  adr: ['ADR-047', 'ADR-048', 'ADR-055', 'ADR-056', 'ADR-057'],
  mcpSection: 'puzzles',
};
