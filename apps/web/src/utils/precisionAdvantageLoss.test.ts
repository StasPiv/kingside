import { describe, it, expect } from 'vitest';
import { computeAdvantageLossPct } from './precisionAdvantageLoss';

describe('computeAdvantageLossPct (KS-3040)', () => {
  it('full advantage lost: +1 → -1 → 100%', () => {
    expect(computeAdvantageLossPct(1.0, -1.0)).toBe(100);
  });

  it('full advantage held: +1 → +1 → 0%', () => {
    expect(computeAdvantageLossPct(1.0, 1.0)).toBe(0);
  });

  it('half advantage lost: +0.5 → -0.5 → 50%', () => {
    expect(computeAdvantageLossPct(0.5, -0.5)).toBe(50);
  });

  it('quarter advantage lost: +0.5 → 0 → 25%', () => {
    expect(computeAdvantageLossPct(0.5, 0)).toBe(25);
  });

  it('recovery (end > start) clamps to 0%', () => {
    expect(computeAdvantageLossPct(0, 0.5)).toBe(0);
    expect(computeAdvantageLossPct(-1.0, 1.0)).toBe(0);
  });

  it('пограничный кейс из жалобы (KS-3040, баг 1) — старт 100% W → финал 0% W: ≤ 100', () => {
    // По скриншоту: 5 полуходов, WDL Start 100/0/0 → ... → 0/9/91
    // (последняя точка обрывалась). Старая формула `wdlLeakSum * 100`
    // выдавала «122%» (сумма drops). Новая возвращает корректные 100%
    // или ниже — net drop от полной победы до полной поражения.
    const result = computeAdvantageLossPct(1.0, -1.0);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
    expect(result).toBe(100);
  });

  it('любые валидные signed WDL → результат всегда [0..100]', () => {
    const samples: Array<[number, number]> = [
      [1, -1],
      [-1, 1],
      [0, 0],
      [0.7, 0.7],
      [1, 0],
      [0.3, -0.4],
      [-0.5, -0.9],
    ];
    for (const [s, e] of samples) {
      const r = computeAdvantageLossPct(s, e);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(100);
    }
  });
});
