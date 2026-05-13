import type { AssistantFeature } from './types.js';

export const studies: AssistantFeature = {
  id: 'studies',
  title: 'Studies',
  paths: [
    '/studies',
    '/studies/:slug',
    '/studies/:slug/:chapterId',
    '/studies/c/:chapterId',
  ],
  summary:
    'Multi-chapter analysis collections (similar to Lichess studies): a user-owned, public or private set of annotated PGN trees.',
  auth: 'optional',
  featureFlag: 'studiesEnabled',
  adr: ['ADR-060'],
  mcpSection: 'studies',
};
