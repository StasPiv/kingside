/**
 * KS-4762. Правило `guest-features-discovery`.
 *
 * DSL:
 *   all:
 *     - actorType: guest
 *     - page: /
 *     - count guest_landing_viewed windowMin=3 gte=2
 *     - not exists guest_signup_form_opened
 */
import { minutesAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'guest-features-discovery',
  actorType: 'guest',
  matches: {
    page: '/',
    events: [
      { type: 'guest_landing_viewed', created_at: minutesAgo(1) },
      { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
    ],
  },
  noMatch: {
    page: '/',
    events: [
      // 2 landing — но форма уже открывалась → not.exists отрежет
      { type: 'guest_landing_viewed', created_at: minutesAgo(1) },
      { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
      { type: 'guest_signup_form_opened', created_at: minutesAgo(1) },
    ],
  },
};
export default fixture;
