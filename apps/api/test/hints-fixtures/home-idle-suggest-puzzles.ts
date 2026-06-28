/**
 * KS-4762. Правило `home-idle-suggest-puzzles`.
 *
 * DSL:
 *   all:
 *     - actorType: user
 *     - page: /play
 *     - count session_idle where page='/play' windowMin=5 gte=1
 */
import { minutesAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'home-idle-suggest-puzzles',
  actorType: 'user',
  matches: {
    page: '/play',
    events: [
      { type: 'session_idle', payload: { page: '/play' }, created_at: minutesAgo(2) },
    ],
  },
  noMatch: {
    page: '/play',
    events: [
      // session_idle на ДРУГОЙ странице — where{page:'/play'} не сматчит
      { type: 'session_idle', payload: { page: '/puzzles' }, created_at: minutesAgo(2) },
    ],
  },
};
export default fixture;
