import type { AssistantFeature } from './types.js';

export const lessons: AssistantFeature = {
  id: 'lessons',
  title: 'Lessons (courses)',
  paths: [
    '/lessons',
    '/lessons/my-active',
    '/lessons/discover',
    '/lessons/editor',
    '/lessons/my/:slug/edit',
    '/lessons/:courseSlug',
    '/lessons/:courseSlug/:lessonSlug',
  ],
  summary:
    'Structured chess courses authored on the platform: each course is a sequence of lessons combining text, board positions, and exercises.',
  auth: 'optional',
  featureFlag: 'lessonsEnabled',
  mcpSection: 'lessons',
};
