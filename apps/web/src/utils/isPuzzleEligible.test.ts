/**
 * KS-3634 / ADR-104 §8. Тесты pure-функции `isPuzzleEligible`.
 */
import { describe, it, expect } from 'vitest';

import { isPuzzleEligible } from './isPuzzleEligible';

describe('isPuzzleEligible', () => {
  it('maiaTop1Prob === null → true (safe fallback, до бэкфилла)', () => {
    expect(isPuzzleEligible({ maiaTop1Prob: null }, 0.5)).toBe(true);
  });

  it('maiaTop1Prob === undefined → true (старый PuzzleDto, поле отсутствует)', () => {
    expect(isPuzzleEligible({}, 0.5)).toBe(true);
  });

  it('maiaTop1Prob <= threshold → true', () => {
    expect(isPuzzleEligible({ maiaTop1Prob: 0.3 }, 0.5)).toBe(true);
    expect(isPuzzleEligible({ maiaTop1Prob: 0.5 }, 0.5)).toBe(true);
    expect(isPuzzleEligible({ maiaTop1Prob: 0 }, 0.5)).toBe(true);
  });

  it('maiaTop1Prob > threshold → false', () => {
    expect(isPuzzleEligible({ maiaTop1Prob: 0.51 }, 0.5)).toBe(false);
    expect(isPuzzleEligible({ maiaTop1Prob: 0.9 }, 0.5)).toBe(false);
    expect(isPuzzleEligible({ maiaTop1Prob: 1 }, 0.5)).toBe(false);
  });

  it('NaN / Infinity → true (safe fallback, не считаем такой пазл «плохим»)', () => {
    expect(isPuzzleEligible({ maiaTop1Prob: NaN }, 0.5)).toBe(true);
    expect(isPuzzleEligible({ maiaTop1Prob: Infinity }, 0.5)).toBe(true);
  });

  it('кастомный threshold', () => {
    expect(isPuzzleEligible({ maiaTop1Prob: 0.7 }, 0.8)).toBe(true);
    expect(isPuzzleEligible({ maiaTop1Prob: 0.9 }, 0.8)).toBe(false);
  });
});
