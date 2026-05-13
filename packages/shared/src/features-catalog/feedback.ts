import type { AssistantFeature } from './types.js';

export const feedback: AssistantFeature = {
  id: 'feedback',
  title: 'Feedback board',
  paths: ['/feedback', '/feedback/:id'],
  summary:
    'Community feedback board. Users submit feedback (bug reports, suggestions, questions), vote on existing posts, and comment. Anonymous posting is allowed.',
  highlights: [
    'Feedback board at {siteUrl}/feedback — submit feedback, vote, filter by type (bug, suggestion, question) or status (open, planned, in-progress, done), sort by newest or most voted',
    'Single feedback post at {siteUrl}/feedback/:id — detail view with comments',
  ],
  auth: 'optional',
  featureFlag: null,
  mcpSection: 'feedback',
};
