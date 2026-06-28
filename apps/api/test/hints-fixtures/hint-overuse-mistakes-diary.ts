/**
 * KS-4762. Правило `hint-overuse-mistakes-diary`.
 *
 * DSL:
 *   all:
 *     - actorType: user
 *     - page: /player/*\/* (двусегментный)
 *     - count hint_used windowDays=7 gte=5
 *     - not exists feature_used where {feature:'mistakes-diary'} (за 7д)
 */
import { hoursAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'hint-overuse-mistakes-diary',
  actorType: 'user',
  matches: {
    page: '/player/staspivovartsev/puzzles',
    events: [
      { type: 'hint_used', created_at: hoursAgo(1) },
      { type: 'hint_used', created_at: hoursAgo(2) },
      { type: 'hint_used', created_at: hoursAgo(3) },
      { type: 'hint_used', created_at: hoursAgo(4) },
      { type: 'hint_used', created_at: hoursAgo(5) },
    ],
  },
  noMatch: {
    page: '/player/staspivovartsev/puzzles',
    events: [
      // 5 hint_used есть, но feature_used отрежет not.exists
      { type: 'hint_used', created_at: hoursAgo(1) },
      { type: 'hint_used', created_at: hoursAgo(2) },
      { type: 'hint_used', created_at: hoursAgo(3) },
      { type: 'hint_used', created_at: hoursAgo(4) },
      { type: 'hint_used', created_at: hoursAgo(5) },
      { type: 'feature_used', payload: { feature: 'mistakes-diary' }, created_at: hoursAgo(6) },
    ],
  },
};
export default fixture;
