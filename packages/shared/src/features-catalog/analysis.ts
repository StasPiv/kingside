import type { AssistantFeature } from './types.js';

export const analysis: AssistantFeature = {
  id: 'analysis',
  title: 'Analysis board',
  paths: ['/analysis', '/analysis/:id', '/analysis/public/:id'],
  summary:
    'Powerful analysis board for arbitrary positions and games. Paste a PGN or FEN, paste a game ID to load a played game, or open a saved analysis. Stockfish 18 runs locally in the browser (WebAssembly) — no server needed.',
  highlights: [
    'New analysis at {siteUrl}/analysis — paste PGN, FEN, or game ID to start',
    'Saved analysis at {siteUrl}/analysis/:id — reopen and continue a previously saved analysis',
    'Public read-only at {siteUrl}/analysis/public/:id — share an analysis by link, no auth required to view',
    'Features: evaluation bar, best move arrows, multiple analysis lines (MultiPV), move-by-move navigation, opening classification (ECO codes), material balance display',
    'Engine depth and number of lines are configurable',
    'Analyses can be saved with a title and accessed later from Workshop',
  ],
  auth: 'optional',
  featureFlag: null,
  mcpSection: 'analyses',
};
