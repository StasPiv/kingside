/**
 * KS-4762 / ADR-150 T4. Реестр фикстур для hints-rules.e2e-spec.ts.
 * Каждая фикстура соответствует активному правилу в БД.
 *
 * Когда добавляется новое правило через admin API — добавь файл
 * <key>.ts с matches/noMatch и зарегистрируй в массиве FIXTURES.
 */
import analyzeAfterLoss from './analyze-after-loss';
import guestPlayFriction from './guest-play-friction';
import guestRegisterPrompt from './guest-register-prompt';
import mistakesDiaryAfterFailures from './mistakes-diary-after-failures';
import hintOveruseMistakesDiary from './hint-overuse-mistakes-diary';
import discoverPuzzleRush from './discover-puzzle-rush';
import bridgePromoAfter3Wasm from './bridge-promo-after-3-wasm';
import guestTryPuzzles from './guest-try-puzzles';
import puzzleComebackAfterWeek from './puzzle-comeback-after-week';
import rushStreakRecovery from './rush-streak-recovery';
import homeIdleSuggestPuzzles from './home-idle-suggest-puzzles';
import guestFeaturesDiscovery from './guest-features-discovery';
import type { RuleFixture } from './types';

export const FIXTURES: RuleFixture[] = [
  analyzeAfterLoss,
  guestPlayFriction,
  guestRegisterPrompt,
  mistakesDiaryAfterFailures,
  hintOveruseMistakesDiary,
  discoverPuzzleRush,
  bridgePromoAfter3Wasm,
  guestTryPuzzles,
  puzzleComebackAfterWeek,
  rushStreakRecovery,
  homeIdleSuggestPuzzles,
  guestFeaturesDiscovery,
];

export type { RuleFixture, FixtureEvent, FixtureScenario } from './types';
