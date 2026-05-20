import type { AssistantFeature } from './types.js';

export const analysis: AssistantFeature = {
  id: 'analysis',
  title: 'Analysis board',
  paths: ['/analysis', '/analysis/:id', '/analysis/public/:id'],
  summary:
    'Analysis board for arbitrary positions or PGNs with engine evaluation, variations, NAG annotations, and optional image-to-FEN to set a position from a board photo or screenshot.',
  auth: 'optional',
  featureFlag: null,
  adr: ['ADR-040'],
  mcpSection: 'analyses',
};
