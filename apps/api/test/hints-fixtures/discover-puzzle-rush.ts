/**
 * KS-4762. Правило `discover-puzzle-rush`.
 *
 * DSL:
 *   all:
 *     - actorType: user
 *     - any: [page /puzzles, page /puzzles/*]
 *     - count puzzle_solved windowDays=30 gte=10
 *     - not exists ... (rush_started за 30д)
 */
import { daysAgo, hoursAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'discover-puzzle-rush',
  actorType: 'user',
  matches: {
    page: '/puzzles',
    events: Array.from({ length: 10 }, (_, i) => ({
      type: 'puzzle_solved',
      created_at: hoursAgo(i + 1),
    })),
  },
  noMatch: {
    page: '/puzzles',
    events: [
      // 10 puzzle_solved + rush_started в окне 30д → not.exists отсечёт
      ...Array.from({ length: 10 }, (_, i) => ({
        type: 'puzzle_solved',
        created_at: hoursAgo(i + 1),
      })),
      { type: 'rush_started', created_at: daysAgo(5) },
    ],
  },
};
export default fixture;
