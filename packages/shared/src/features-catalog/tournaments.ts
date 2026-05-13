import type { AssistantFeature } from './types.js';

export const tournaments: AssistantFeature = {
  id: 'tournaments',
  title: 'Tournaments',
  paths: ['/tournaments', '/tournaments/:id', '/arena/:id'],
  summary:
    'Three tournament formats: Arena, Swiss, and Round Robin. Tournaments can be filtered by status (upcoming, active, finished) and time control. Authenticated users can create or join tournaments.',
  highlights: [
    'Tournaments lobby at {siteUrl}/tournaments — list of upcoming, active, and finished tournaments with filters',
    'Tournament page at {siteUrl}/tournaments/:id — standings, pairings, chat, and the Join button',
    'Arena page at {siteUrl}/arena/:id — same tournament screen accessed by the arena route alias',
    'Arena format: continuous pairing. Play as many games as possible within the tournament duration. Points for wins and draws. No fixed rounds — new game starts immediately after the previous one ends',
    'Swiss format: fixed number of rounds. Players paired by score. Players with similar scores face each other',
    'Round Robin format: every participant plays every other participant',
  ],
  caveats: [
    'Joining or creating a tournament requires authentication',
  ],
  auth: 'optional',
  featureFlag: 'tournamentsEnabled',
  mcpSection: 'tournaments',
};
