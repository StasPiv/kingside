import type { AssistantFeature } from './types.js';

export const trainLobby: AssistantFeature = {
  id: 'train-lobby',
  title: 'Training hub',
  paths: ['/train'],
  summary:
    'Hub page that aggregates training modes (puzzles, puzzle rush, precision, drills, mistakes, lessons) for the user to pick from one screen.',
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
