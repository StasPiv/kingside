/**
 * KS-4762. Правило `puzzle-comeback-after-week`.
 *
 * DSL:
 *   all:
 *     - actorType: user
 *     - any: [page /play, page /play/*]
 *     - timeSince puzzle_start gtDays=7
 *
 * Семантика timeSince: gtDays=7 → правило сматчится если последний
 * `puzzle_start` был БОЛЕЕ 7 дней назад ИЛИ если события не было совсем.
 */
import { daysAgo, hoursAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'puzzle-comeback-after-week',
  actorType: 'user',
  matches: {
    page: '/play',
    // последний puzzle_start 10 дней назад > gtDays:7
    events: [{ type: 'puzzle_start', created_at: daysAgo(10) }],
  },
  noMatch: {
    page: '/play',
    // недавний puzzle_start (3ч назад) < 7 дней
    events: [{ type: 'puzzle_start', created_at: hoursAgo(3) }],
  },
};
export default fixture;
