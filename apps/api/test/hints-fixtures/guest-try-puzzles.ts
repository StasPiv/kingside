/**
 * KS-4762. Правило `guest-try-puzzles`.
 *
 * DSL:
 *   all:
 *     - actorType: guest
 *     - page: /
 *     - count guest_landing_viewed windowMin=10 gte=2
 *     - not exists guest_puzzle_attempted (за windowMin/Hours...)
 */
import { minutesAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'guest-try-puzzles',
  actorType: 'guest',
  matches: {
    page: '/',
    events: [
      { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
      { type: 'guest_landing_viewed', created_at: minutesAgo(8) },
    ],
  },
  noMatch: {
    page: '/',
    events: [
      // landing посетили 2 раза, но уже пробовали пазл — not.exists отрежет
      { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
      { type: 'guest_landing_viewed', created_at: minutesAgo(8) },
      { type: 'guest_puzzle_attempted', created_at: minutesAgo(5) },
    ],
  },
};
export default fixture;
