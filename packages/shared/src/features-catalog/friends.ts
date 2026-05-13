import type { AssistantFeature } from './types.js';

export const friends: AssistantFeature = {
  id: 'friends',
  title: 'Friends',
  paths: ['/friends'],
  summary:
    'Friends list with online/offline status and ratings. Send, accept, or decline friend requests. Challenge friends to a game directly from the friends page.',
  highlights: [
    'Friends list at {siteUrl}/friends — see who is online, their ratings, send a direct game challenge',
    'Manage friend requests (send / accept / decline) from the same screen',
  ],
  caveats: ['Requires authentication'],
  auth: 'user',
  featureFlag: null,
  mcpSection: 'friends',
};
