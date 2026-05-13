import type { AssistantFeature } from './types.js';

export const tournaments: AssistantFeature = {
  id: 'tournaments',
  title: 'Tournaments',
  paths: ['/tournaments', '/tournaments/:id', '/arena/:id'],
  summary:
    'Tournaments in three formats — Arena, Swiss, and Round Robin — with filters by status and time control; users can create or join.',
  auth: 'optional',
  featureFlag: 'tournamentsEnabled',
  mcpSection: 'tournaments',
};
