import type { AssistantFeature } from './types.js';

export const mistakes: AssistantFeature = {
  id: 'mistakes',
  title: 'Mistakes practice',
  paths: ['/puzzles/mistakes', '/puzzles/mistakes-practice'],
  summary:
    'Personalized training on positions where the user previously made mistakes. The system harvests mistakes from analyzed games and surfaces them as practice puzzles so the user can rehearse the correct move.',
  highlights: [
    'Mistakes list at {siteUrl}/puzzles/mistakes — browse mistakes collected from your analyzed games, filter by theme / opening / severity',
    'Practice mode at {siteUrl}/puzzles/mistakes-practice — solve mistakes back-to-back as a focused training session',
  ],
  caveats: [
    'Requires authentication',
    'Mistakes are sourced from two channels: (a) failed attempts in the puzzle trainer (source=puzzle), (b) blunders detected during game review (source=game_review)',
    'Practice mode rotates positions within ±200 of the user\'s puzzle rating',
  ],
  auth: 'user',
  featureFlag: 'puzzlesEnabled',
  mcpSection: 'puzzles',
};
