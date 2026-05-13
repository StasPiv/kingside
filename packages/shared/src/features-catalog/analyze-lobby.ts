import type { AssistantFeature } from './types.js';

export const analyzeLobby: AssistantFeature = {
  id: 'analyze-lobby',
  title: 'Analysis hub',
  paths: ['/analyze'],
  summary:
    'Hub page that aggregates analysis-oriented sections: analysis board, workshop, studies, and the archive. The user picks how to start an analysis session from one screen.',
  highlights: [
    'Analysis hub at {siteUrl}/analyze — shortcut entry point for analysis tools',
  ],
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
