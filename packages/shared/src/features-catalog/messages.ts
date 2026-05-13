import type { AssistantFeature } from './types.js';

export const messages: AssistantFeature = {
  id: 'messages',
  title: 'Messages',
  paths: ['/messages', '/messages/:userId'],
  summary:
    'Direct messaging between users. Conversation list, message history, real-time delivery.',
  highlights: [
    'Conversations at {siteUrl}/messages — list of your conversations sorted by recency',
    'Chat with a specific user at {siteUrl}/messages/:userId — message history and live updates',
  ],
  caveats: ['Requires authentication'],
  auth: 'user',
  featureFlag: null,
  mcpSection: 'messages',
};
