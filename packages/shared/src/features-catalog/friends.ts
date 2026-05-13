import type { AssistantFeature } from './types.js';

export const friends: AssistantFeature = {
  id: 'friends',
  title: 'Friends',
  paths: ['/friends'],
  summary:
    'Friends list with online status and ratings; send, accept, or decline friend requests and challenge friends to a game.',
  auth: 'user',
  featureFlag: null,
  mcpSection: 'friends',
};
