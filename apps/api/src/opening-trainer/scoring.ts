import { OPENING_TRAINER_SCORING } from '@kingside/shared';

/**
 * KS-3272 (ADR-077 §2.7). Чистая функция скоринга одного user-move'а.
 *
 * Правила:
 *   - wrong:              −5 баллов, минимум баланс 0 (не уходим в минус)
 *   - correct (no hint):  +10
 *   - correct (with hint): +5
 *   - fast bonus:         +1 за correct ход за < 5 секунд от показа позиции
 *   - streak multiplier:  ×1.2 на следующих correct, если currentStreak ≥ 5
 *
 * Не дёргает DB / chess.js — caller передаёт всё нужное и записывает
 * результат в `OpeningTrainerSession` и `OpeningTrainerAttempt`.
 */

export interface ScoringInput {
  /** Был ли user-move правильным (есть в edges репертуара). */
  correct: boolean;
  /** Использовалась ли подсказка для этой позиции. */
  hintUsed: boolean;
  /** Streak ДО этого хода (`session.currentStreak`). После — пересчитывается. */
  currentStreak: number;
  /** Время от показа позиции до отправки хода (мс). */
  responseTimeMs: number;
  /** Текущий счёт сессии (`session.score`), для clamp wrong-делты. */
  currentScore: number;
}

export interface ScoringResult {
  /** Прирост к `session.score` (может быть отрицательным или 0). */
  scoreDelta: number;
  /** Новое значение `session.currentStreak`. */
  newStreak: number;
  /** Был ли применён fast-bonus (+1 за быстрый правильный). */
  fastBonus: boolean;
  /** Был ли применён streak-multiplier (×1.2 за серию). */
  streakBonus: boolean;
}

export function computeScoreDelta(input: ScoringInput): ScoringResult {
  if (!input.correct) {
    // -5 баллов, но не ниже 0 (clamp).
    const natural = OPENING_TRAINER_SCORING.wrong;
    const clamped = Math.max(natural, -input.currentScore);
    return {
      scoreDelta: clamped,
      newStreak: 0,
      fastBonus: false,
      streakBonus: false,
    };
  }

  // correct:
  const base = input.hintUsed
    ? OPENING_TRAINER_SCORING.correctWithHint
    : OPENING_TRAINER_SCORING.correctNoHint;
  const isFast = input.responseTimeMs < OPENING_TRAINER_SCORING.fastBonusMs;
  const fastDelta = isFast ? OPENING_TRAINER_SCORING.fastBonusPoints : 0;

  // Streak-bonus: серия ≥ 5 на момент ДО этого хода → multiplier на ВЕСЬ
  // base+fast (не только base). Math.floor — не плодим дроби в БД.
  const isStreaking =
    input.currentStreak >= OPENING_TRAINER_SCORING.streakThreshold;
  let total = base + fastDelta;
  if (isStreaking) {
    total = Math.floor(total * OPENING_TRAINER_SCORING.streakMultiplier);
  }

  return {
    scoreDelta: total,
    newStreak: input.currentStreak + 1,
    fastBonus: isFast,
    streakBonus: isStreaking,
  };
}
