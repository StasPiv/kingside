/**
 * KS-4762. Правило `guest-play-friction`.
 *
 * DSL:
 *   all:
 *     - actorType: guest
 *     - page: /
 *     - count guest_play_attempted windowHours=1 gte=2
 */
import { minutesAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'guest-play-friction',
  actorType: 'guest',
  matches: {
    page: '/',
    events: [
      { type: 'guest_play_attempted', created_at: minutesAgo(10) },
      { type: 'guest_play_attempted', created_at: minutesAgo(20) },
    ],
  },
  noMatch: {
    page: '/',
    events: [
      // только 1 < gte=2
      { type: 'guest_play_attempted', created_at: minutesAgo(10) },
    ],
  },
};
export default fixture;
