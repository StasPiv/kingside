import type { AssistantFeature } from './types.js';

export const profile: AssistantFeature = {
  id: 'profile',
  title: 'Profile (your own)',
  paths: ['/profile'],
  summary:
    'Shortcut entry that redirects to the user\'s own public player profile (ratings, game history, link to settings).',
  auth: 'user',
  featureFlag: null,
  mcpSection: 'users',
};
