import type { AssistantFeature } from './types.js';

export const home: AssistantFeature = {
  id: 'home',
  title: 'Home and platform overview',
  paths: ['/', '/features'],
  summary:
    'Landing entry point: signed-in users are sent to the play hub, guests see a feature overview of the platform.',
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
