/**
 * KS-4762. Правило `guest-register-prompt`.
 *
 * DSL:
 *   all:
 *     - actorType: guest
 *     - page: /
 *     - count guest_landing_viewed windowMin=5 gte=1
 *     - not exists guest_signup_form_opened (windowMin=...)
 */
import { minutesAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'guest-register-prompt',
  actorType: 'guest',
  matches: {
    page: '/',
    events: [
      { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
    ],
  },
  noMatch: {
    page: '/',
    events: [
      // landing был, но форма уже открывалась — not.exists отрежет
      { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
      { type: 'guest_signup_form_opened', created_at: minutesAgo(1) },
    ],
  },
};
export default fixture;
