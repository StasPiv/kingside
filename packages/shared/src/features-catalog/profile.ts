import type { AssistantFeature } from './types.js';

export const profile: AssistantFeature = {
  id: 'profile',
  title: 'Profile (your own)',
  paths: ['/profile'],
  summary:
    'Your own profile. Shortcut route that redirects to your public player profile — all ratings, game history, and a link to settings.',
  highlights: [
    'Your profile at {siteUrl}/profile — auto-redirects to your public player profile at /player/:username',
  ],
  caveats: ['Requires authentication'],
  auth: 'user',
  featureFlag: null,
  mcpSection: null,
};
