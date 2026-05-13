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
    'Multi-chapter analysis collections (similar to Lichess studies). A study is owned by a user, can be public or private, and contains chapters — each chapter is a PGN tree with annotations, variations, and optional gamebook prompts.',
  highlights: [
    'Studies catalog at {siteUrl}/studies — list of your studies and public studies, filter by tab (mine / public)',
    'Single study at {siteUrl}/studies/:slug — chapter list with descriptions and counts',
    'Chapter editor at {siteUrl}/studies/:slug/:chapterId — analysis board with full editing (variations, comments, gamebook setup) for the study owner',
    'Public read-only chapter at {siteUrl}/studies/c/:chapterId — direct link to a chapter for sharing (no auth required if the study is public)',
  ],
  auth: 'optional',
  featureFlag: 'studiesEnabled',
  adr: ['ADR-060'],
  mcpSection: 'studies',
};
