import type { AssistantFeature } from './types.js';

export const feedback: AssistantFeature = {
  id: 'feedback',
  title: 'Feedback board',
  paths: ['/feedback', '/feedback/:id'],
  summary:
    'Community feedback board where users submit bug reports, suggestions, and questions, vote on existing posts, and comment.',
  auth: 'optional',
  featureFlag: null,
  mcpSection: 'feedback',
};
