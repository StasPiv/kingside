import type { AssistantFeature } from './types.js';

export const trainLobby: AssistantFeature = {
  id: 'train-lobby',
  title: 'Training hub',
  paths: ['/train'],
  summary:
    'Hub page that aggregates training-oriented sections: puzzles, puzzle rush, precision, drills, mistakes practice, and lessons. The user picks a training mode from one screen.',
  highlights: [
    'Training hub at {siteUrl}/train — shortcut entry point for all training modes',
  ],
  auth: 'public',
  featureFlag: null,
  mcpSection: null,
};
