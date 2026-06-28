/**
 * KS-4762. Правило `rush-streak-recovery`.
 *
 * DSL:
 *   all:
 *     - actorType: user
 *     - any: [page /puzzles, page /puzzles/*]
 *     - count rush_streak_broken windowHours=24 gte=2
 */
import { hoursAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'rush-streak-recovery',
  actorType: 'user',
  matches: {
    page: '/puzzles',
    events: [
      { type: 'rush_streak_broken', created_at: hoursAgo(2) },
      { type: 'rush_streak_broken', created_at: hoursAgo(5) },
    ],
  },
  noMatch: {
    page: '/puzzles',
    events: [
      // только 1 < gte=2
      { type: 'rush_streak_broken', created_at: hoursAgo(2) },
    ],
  },
};
export default fixture;
