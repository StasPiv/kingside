import type { AssistantFeature } from './types.js';

export const analysis: AssistantFeature = {
  id: 'analysis',
  title: 'Analysis board',
  paths: ['/analysis', '/analysis/:id', '/analysis/public/:id'],
  summary:
    'Analysis board for arbitrary positions or PGNs, powered by Stockfish 18 running locally in the browser (WebAssembly).',
  auth: 'optional',
  featureFlag: null,
  mcpSection: 'analyses',
};
