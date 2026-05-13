import type { AssistantFeature } from './types.js';

export const docs: AssistantFeature = {
  id: 'docs',
  title: 'Documentation pages',
  paths: ['/docs/user-courses', '/help/external-engine'],
  summary:
    'In-app documentation pages with user-facing help. Currently covers how to author user courses and how to connect an external chess engine to the analysis board.',
  highlights: [
    'User courses guide at {siteUrl}/docs/user-courses — explains how to create a course inside the lessons section',
    'External engine help at {siteUrl}/help/external-engine — guide for connecting a local UCI engine to the analysis board',
  ],
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
