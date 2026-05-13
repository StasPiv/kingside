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
    'Structured chess courses authored on the platform. A course is a sequence of lessons; each lesson combines text, board positions, and interactive exercises. Users can enrol in courses and track their progress.',
  highlights: [
    'Lessons home at {siteUrl}/lessons — main landing for the lessons section',
    'My active courses at {siteUrl}/lessons/my-active — courses the user is currently progressing through',
    'Discover courses at {siteUrl}/lessons/discover — public catalog of available courses (no auth needed to browse)',
    'Lesson editor at {siteUrl}/lessons/editor — author or edit a course (creator-side)',
    'Edit own course at {siteUrl}/lessons/my/:slug/edit — modify a course the user has created',
    'Course page at {siteUrl}/lessons/:courseSlug — overview of a single course with its lessons',
    'Lesson page at {siteUrl}/lessons/:courseSlug/:lessonSlug — go through a single lesson interactively',
  ],
  caveats: [
    'Most pages require authentication; the discover page is public',
  ],
  auth: 'optional',
  featureFlag: 'lessonsEnabled',
  mcpSection: 'lessons',
};
