/**
 * KS-4762. Правило `mistakes-diary-after-failures`.
 *
 * DSL:
 *   all:
 *     - actorType: user
 *     - any: [page /player/*, page /player/*\/*]
 *     - count puzzle_failed windowDays=7 gte=5
 *     - not exists ... (визит на /puzzles/mistakes за 7 дней)
 */
import { daysAgo, hoursAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'mistakes-diary-after-failures',
  actorType: 'user',
  matches: {
    page: '/player/staspivovartsev',
    events: [
      { type: 'puzzle_failed', created_at: hoursAgo(1) },
      { type: 'puzzle_failed', created_at: hoursAgo(2) },
      { type: 'puzzle_failed', created_at: hoursAgo(3) },
      { type: 'puzzle_failed', created_at: hoursAgo(4) },
      { type: 'puzzle_failed', created_at: hoursAgo(5) },
    ],
  },
  noMatch: {
    page: '/player/staspivovartsev',
    events: [
      // только 4 < gte=5
      { type: 'puzzle_failed', created_at: daysAgo(1) },
      { type: 'puzzle_failed', created_at: daysAgo(2) },
      { type: 'puzzle_failed', created_at: daysAgo(3) },
      { type: 'puzzle_failed', created_at: daysAgo(4) },
    ],
  },
};
export default fixture;
