/**
 * KS-4762. Правило `bridge-promo-after-3-wasm`.
 *
 * DSL:
 *   all:
 *     - any: [page /analysis, page /analysis/*]
 *     - count engine_started where source=wasm windowDays=30 gte=3
 *     - not exists engine_started where source=bridge windowDays=30
 *
 * Внимание: actorType отсутствует в DSL, но targetActorTypes=['user']
 * на уровне Hint. Suite использует actorType=user.
 */
import { hoursAgo, daysAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'bridge-promo-after-3-wasm',
  actorType: 'user',
  matches: {
    page: '/analysis',
    events: [
      { type: 'engine_started', payload: { source: 'wasm' }, created_at: hoursAgo(1) },
      { type: 'engine_started', payload: { source: 'wasm' }, created_at: hoursAgo(2) },
      { type: 'engine_started', payload: { source: 'wasm' }, created_at: hoursAgo(3) },
    ],
  },
  noMatch: {
    page: '/analysis',
    events: [
      // 3 wasm запуска есть, но и bridge тоже → not.exists отрезает
      { type: 'engine_started', payload: { source: 'wasm' }, created_at: hoursAgo(1) },
      { type: 'engine_started', payload: { source: 'wasm' }, created_at: hoursAgo(2) },
      { type: 'engine_started', payload: { source: 'wasm' }, created_at: hoursAgo(3) },
      { type: 'engine_started', payload: { source: 'bridge' }, created_at: daysAgo(2) },
    ],
  },
};
export default fixture;
