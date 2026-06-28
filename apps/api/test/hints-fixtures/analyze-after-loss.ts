/**
 * KS-4762 / ADR-150 T4. Фикстура для правила `analyze-after-loss`.
 *
 * DSL:
 *   all:
 *     - actorType: user
 *     - any: [page /game/*, page /play/*]
 *     - count game_end where result=loss windowDays=7 gte=3
 *     - not exists analysis_open windowMin=30
 */
import { hoursAgo, daysAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'analyze-after-loss',
  actorType: 'user',
  matches: {
    page: '/game/00000000-0000-4000-8000-000000000001',
    events: [
      { type: 'game_end', payload: { result: 'loss' }, created_at: hoursAgo(1) },
      { type: 'game_end', payload: { result: 'loss' }, created_at: hoursAgo(2) },
      { type: 'game_end', payload: { result: 'loss' }, created_at: hoursAgo(3) },
    ],
  },
  noMatch: {
    page: '/game/00000000-0000-4000-8000-000000000001',
    events: [
      // только 2 проигрыша < gte=3
      { type: 'game_end', payload: { result: 'loss' }, created_at: hoursAgo(1) },
      { type: 'game_end', payload: { result: 'loss' }, created_at: hoursAgo(2) },
      // и game_end{win} не считается
      { type: 'game_end', payload: { result: 'win' }, created_at: hoursAgo(3) },
      // analysis_open в окне 30 мин — отсечёт `not.exists` (на случай если count пройдёт)
      { type: 'analysis_open', created_at: hoursAgo(0) },
    ],
  },
};
export default fixture;
