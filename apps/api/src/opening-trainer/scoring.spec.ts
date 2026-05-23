import { computeScoreDelta } from './scoring';

/**
 * KS-3272 / ADR-077 §2.7.
 */

describe('computeScoreDelta', () => {
  it('correct, без hint, средний темп → +10, streak +1', () => {
    const r = computeScoreDelta({
      correct: true,
      hintUsed: false,
      currentStreak: 0,
      responseTimeMs: 8000,
      currentScore: 0,
    });
    expect(r.scoreDelta).toBe(10);
    expect(r.newStreak).toBe(1);
    expect(r.fastBonus).toBe(false);
    expect(r.streakBonus).toBe(false);
  });

  it('correct + hint → +5', () => {
    const r = computeScoreDelta({
      correct: true,
      hintUsed: true,
      currentStreak: 0,
      responseTimeMs: 8000,
      currentScore: 0,
    });
    expect(r.scoreDelta).toBe(5);
  });

  it('correct + fast (<5s, no hint) → +10 +1 = 11', () => {
    const r = computeScoreDelta({
      correct: true,
      hintUsed: false,
      currentStreak: 0,
      responseTimeMs: 3000,
      currentScore: 0,
    });
    expect(r.scoreDelta).toBe(11);
    expect(r.fastBonus).toBe(true);
  });

  it('correct + hint + fast → +5 +1 = 6', () => {
    const r = computeScoreDelta({
      correct: true,
      hintUsed: true,
      currentStreak: 0,
      responseTimeMs: 2000,
      currentScore: 50,
    });
    expect(r.scoreDelta).toBe(6);
  });

  it('граница fast = 5000ms (НЕ применяется на ровно 5000)', () => {
    const r = computeScoreDelta({
      correct: true,
      hintUsed: false,
      currentStreak: 0,
      responseTimeMs: 5000,
      currentScore: 0,
    });
    expect(r.fastBonus).toBe(false);
    expect(r.scoreDelta).toBe(10);
  });

  it('streak < 5 → multiplier НЕ применяется', () => {
    const r = computeScoreDelta({
      correct: true,
      hintUsed: false,
      currentStreak: 4,
      responseTimeMs: 8000,
      currentScore: 0,
    });
    expect(r.scoreDelta).toBe(10);
    expect(r.streakBonus).toBe(false);
    expect(r.newStreak).toBe(5);
  });

  it('streak = 5 → multiplier ×1.2 (floor) применяется на следующем correct', () => {
    const r = computeScoreDelta({
      correct: true,
      hintUsed: false,
      currentStreak: 5,
      responseTimeMs: 8000,
      currentScore: 0,
    });
    expect(r.streakBonus).toBe(true);
    expect(r.scoreDelta).toBe(Math.floor(10 * 1.2)); // 12
    expect(r.newStreak).toBe(6);
  });

  it('streak + fast → multiplier на (10+1) = floor(13.2) = 13', () => {
    const r = computeScoreDelta({
      correct: true,
      hintUsed: false,
      currentStreak: 5,
      responseTimeMs: 3000,
      currentScore: 0,
    });
    expect(r.scoreDelta).toBe(13);
    expect(r.streakBonus).toBe(true);
    expect(r.fastBonus).toBe(true);
  });

  it('streak + hint → floor((5+0)*1.2) = 6', () => {
    const r = computeScoreDelta({
      correct: true,
      hintUsed: true,
      currentStreak: 5,
      responseTimeMs: 8000,
      currentScore: 0,
    });
    expect(r.scoreDelta).toBe(6);
  });

  it('wrong → −5, streak сброшен в 0', () => {
    const r = computeScoreDelta({
      correct: false,
      hintUsed: false,
      currentStreak: 7,
      responseTimeMs: 4000,
      currentScore: 50,
    });
    expect(r.scoreDelta).toBe(-5);
    expect(r.newStreak).toBe(0);
  });

  it('wrong с score=3 → clamp до -3 (не уходим в минус)', () => {
    const r = computeScoreDelta({
      correct: false,
      hintUsed: false,
      currentStreak: 1,
      responseTimeMs: 4000,
      currentScore: 3,
    });
    expect(r.scoreDelta).toBe(-3);
  });

  it('wrong с score=0 → delta=0 (clamp)', () => {
    const r = computeScoreDelta({
      correct: false,
      hintUsed: false,
      currentStreak: 0,
      responseTimeMs: 4000,
      currentScore: 0,
    });
    // Math.max(-5, -0) = -0 в JS, но семантически = 0. Сравниваем по
    // абсолютному значению, чтобы тест не падал на различии 0/-0.
    expect(Math.abs(r.scoreDelta)).toBe(0);
  });

  it('wrong + hint (странный сценарий, hintUsed игнорируется при wrong)', () => {
    const r = computeScoreDelta({
      correct: false,
      hintUsed: true,
      currentStreak: 5,
      responseTimeMs: 1000,
      currentScore: 50,
    });
    expect(r.scoreDelta).toBe(-5);
    expect(r.newStreak).toBe(0);
  });
});
