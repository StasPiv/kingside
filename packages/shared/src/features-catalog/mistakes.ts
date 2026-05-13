import type { AssistantFeature } from './types.js';

export const mistakes: AssistantFeature = {
  id: 'mistakes',
  title: 'Mistakes practice',
  paths: ['/puzzles/mistakes', '/puzzles/mistakes-practice'],
  summary:
    'Personalized practice on positions where the user previously erred, sourced from failed puzzles and blunders detected during game review.',
  auth: 'user',
  featureFlag: 'puzzlesEnabled',
  mcpSection: 'puzzles',
};
