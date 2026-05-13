import type { AssistantFeature } from './types.js';

export const gamebookReader: AssistantFeature = {
  id: 'gamebook-reader',
  title: 'Gamebook reader',
  paths: [
    '/studies/:slug/:chapterId/play',
    '/studies/c/:chapterId/play',
  ],
  summary:
    'Standalone read-only player for "gamebook" chapters of a study. The user reads the chapter intro, then plays moves against an expected line — correct moves get success feedback, wrong moves get a hint and a retry. Used for guided lessons and puzzles authored as gamebook chapters.',
  highlights: [
    'Play screen at {siteUrl}/studies/:slug/:chapterId/play — by slug + chapter id',
    'Direct link at {siteUrl}/studies/c/:chapterId/play — same screen, accessible by chapter id only',
    'Phases: intro (read explanation, click Start), playing (drag-and-drop, success/failure feedback from the author), finished (main line complete)',
    'No engine, no auto-save — purely a guided reading experience',
  ],
  auth: 'public',
  featureFlag: 'studiesEnabled',
  adr: ['ADR-060'],
  mcpSection: 'studies',
};
