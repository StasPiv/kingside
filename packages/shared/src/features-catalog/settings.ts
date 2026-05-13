import type { AssistantFeature } from './types.js';

export const settings: AssistantFeature = {
  id: 'settings',
  title: 'Settings',
  paths: ['/settings'],
  summary:
    'Account settings page: profile basics, language, board theme and pieces, animation speed, sound, external account display, blocked users.',
  auth: 'user',
  featureFlag: null,
  mcpSection: null,
};
