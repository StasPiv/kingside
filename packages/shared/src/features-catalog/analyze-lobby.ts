import type { AssistantFeature } from './types.js';

export const analyzeLobby: AssistantFeature = {
  id: 'analyze-lobby',
  title: 'Analysis hub',
  paths: ['/analyze'],
  summary:
    'Hub page that aggregates analysis-oriented sections (analysis board, workshop, archive) for picking how to start a session.',
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
