import type { AssistantFeature } from './types.js';

export const docs: AssistantFeature = {
  id: 'docs',
  title: 'Documentation pages',
  paths: ['/docs/user-courses', '/help/external-engine'],
  summary:
    'In-app documentation pages with user-facing help for authoring user courses and connecting an external chess engine to the analysis board.',
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
