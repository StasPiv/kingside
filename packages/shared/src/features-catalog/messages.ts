import type { AssistantFeature } from './types.js';

export const messages: AssistantFeature = {
  id: 'messages',
  title: 'Messages',
  paths: ['/messages', '/messages/:userId'],
  summary:
    'Direct messaging between users with a conversation list, message history, and real-time delivery.',
  auth: 'user',
  featureFlag: null,
  mcpSection: 'messages',
};
