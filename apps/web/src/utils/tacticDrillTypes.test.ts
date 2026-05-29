import { describe, it, expect } from 'vitest';
import { TACTIC_DRILL_TYPES, isTacticDrillType } from './tacticDrillTypes';

/**
 * KS-3414 — валидатор drill-типов: гарантирует, что фронт не отправит
 * GET /tactic-drill/next без валидного `type` (backend 400 на пустой).
 */
describe('isTacticDrillType (KS-3414)', () => {
  it('все 7 канонических типов валидны', () => {
    expect(TACTIC_DRILL_TYPES).toHaveLength(7);
    for (const t of TACTIC_DRILL_TYPES) {
      expect(isTacticDrillType(t)).toBe(true);
    }
  });

  it('пустые/недопустимые значения отклоняются', () => {
    expect(isTacticDrillType('')).toBe(false);
    expect(isTacticDrillType(undefined)).toBe(false);
    expect(isTacticDrillType(null)).toBe(false);
    expect(isTacticDrillType('bogus-type')).toBe(false);
    expect(isTacticDrillType('undefined')).toBe(false);
    // регистр/пробелы — не валидны (точное совпадение).
    expect(isTacticDrillType('Find-Fork')).toBe(false);
    expect(isTacticDrillType(' find-fork')).toBe(false);
  });
});
