/**
 * KS-3075: unit-тесты `pickDisplayedAccuracyPct`. Покрываем:
 *  - scorePct primary, если задан (синхрон с PrecisionScoreBlock);
 *  - accuracyPercent fallback для legacy attempt'ов без scorePct;
 *  - регрессионный кейс жалобы: scorePct=9, accuracyPercent=0 → 9
 *    (раньше верхний блок показывал 0, нижний 9 — расхождение).
 */
import { describe, it, expect } from 'vitest';
import { pickDisplayedAccuracyPct } from './precisionAccuracyDisplay';

describe('pickDisplayedAccuracyPct (KS-3075)', () => {
  it('берёт scorePct когда он задан', () => {
    expect(
      pickDisplayedAccuracyPct({ scorePct: 87, accuracyPercent: 0 }),
    ).toBe(87);
  });

  it('берёт scorePct=0 (валидное значение, не truthy-check)', () => {
    expect(
      pickDisplayedAccuracyPct({ scorePct: 0, accuracyPercent: 50 }),
    ).toBe(0);
  });

  it('fallback на accuracyPercent при scorePct=null (legacy)', () => {
    expect(
      pickDisplayedAccuracyPct({ scorePct: null, accuracyPercent: 73 }),
    ).toBe(73);
  });

  it('fallback на accuracyPercent при scorePct=undefined', () => {
    expect(
      pickDisplayedAccuracyPct({ accuracyPercent: 42 }),
    ).toBe(42);
  });

  it('KS-3075 жалоба: scorePct=9, accuracyPercent=0 → 9 (синхрон со звёздами 1★)', () => {
    // 1★ → scorePct < 50, и scorePct=9 это именно 1★ по STAR_THRESHOLDS.
    // accuracyPercent=0 (Lichess cp-loss) рассинхрон со звёздами.
    expect(
      pickDisplayedAccuracyPct({ scorePct: 9, accuracyPercent: 0 }),
    ).toBe(9);
  });

  it('KS-3075 идеальный кейс: scorePct=100, accuracyPercent=100 → 100', () => {
    expect(
      pickDisplayedAccuracyPct({ scorePct: 100, accuracyPercent: 100 }),
    ).toBe(100);
  });

  it('игнорирует NaN/Infinity scorePct, fallback на accuracyPercent', () => {
    expect(
      pickDisplayedAccuracyPct({ scorePct: NaN, accuracyPercent: 50 }),
    ).toBe(50);
    expect(
      pickDisplayedAccuracyPct({ scorePct: Infinity, accuracyPercent: 50 }),
    ).toBe(50);
  });
});
