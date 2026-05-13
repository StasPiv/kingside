import type { AssistantFeature } from './types.js';

export const home: AssistantFeature = {
  id: 'home',
  title: 'Home and platform overview',
  paths: ['/', '/features'],
  summary:
    'Landing page of the site. For guests, shows a feature overview of the Kingside platform. For authenticated users, the root path redirects to /play. The /features page is always public and lists what the platform offers.',
  highlights: [
    'Root {siteUrl}/ — entry point: signed-in users land on the play hub, guests see the features tour',
    'Features overview at {siteUrl}/features — public read-only catalog of available sections (play, puzzles, analysis, training, tournaments, broadcasts)',
  ],
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
