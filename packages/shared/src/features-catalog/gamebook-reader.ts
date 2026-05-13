import type { AssistantFeature } from './types.js';

export const gamebookReader: AssistantFeature = {
  id: 'gamebook-reader',
  title: 'Gamebook reader',
  paths: [
    '/studies/:slug/:chapterId/play',
    '/studies/c/:chapterId/play',
  ],
  summary:
    'Standalone read-only player for gamebook chapters of a study: the user plays an expected line with success/failure feedback and hints.',
  auth: 'public',
  featureFlag: 'studiesEnabled',
  adr: ['ADR-060'],
  mcpSection: 'studies',
};
