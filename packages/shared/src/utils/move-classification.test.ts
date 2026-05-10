import { describe, it, expect } from 'vitest';
import { classifyMove, MATE_CP_BASE } from './move-classification.js';

describe('classifyMove (KS-2717 / ADR-056 §3.3)', () => {
  it('isBestMove=true → best независимо от cp-loss', () => {
    expect(
      classifyMove({ cpBefore: 100, cpAfter: -500, isBestMove: true }),
    ).toBe('best');
  });

  it('null cpBefore → good (нейтральный фолбек)', () => {
    expect(classifyMove({ cpBefore: null, cpAfter: 50 })).toBe('good');
    expect(classifyMove({ cpBefore: undefined, cpAfter: 50 })).toBe('good');
  });

  it('null cpAfter → good', () => {
    expect(classifyMove({ cpBefore: 100, cpAfter: null })).toBe('good');
  });

  describe('cp-loss buckets', () => {
    it('cpLoss ≤ 0 → best', () => {
      expect(classifyMove({ cpBefore: 100, cpAfter: 100 })).toBe('best');
      expect(classifyMove({ cpBefore: 100, cpAfter: 200 })).toBe('best');
    });

    it('cpLoss = 30 → good (boundary)', () => {
      expect(classifyMove({ cpBefore: 100, cpAfter: 70 })).toBe('good');
    });

    it('cpLoss = 31 → inaccuracy (just above good)', () => {
      expect(classifyMove({ cpBefore: 100, cpAfter: 69 })).toBe('inaccuracy');
    });

    it('cpLoss = 90 → inaccuracy (boundary)', () => {
      expect(classifyMove({ cpBefore: 100, cpAfter: 10 })).toBe('inaccuracy');
    });

    it('cpLoss = 91 → mistake', () => {
      expect(classifyMove({ cpBefore: 100, cpAfter: 9 })).toBe('mistake');
    });

    it('cpLoss = 220 → mistake (boundary)', () => {
      expect(classifyMove({ cpBefore: 200, cpAfter: -20 })).toBe('mistake');
    });

    it('cpLoss = 221 → blunder', () => {
      expect(classifyMove({ cpBefore: 200, cpAfter: -21 })).toBe('blunder');
    });

    it('huge cpLoss → blunder', () => {
      expect(classifyMove({ cpBefore: 500, cpAfter: -500 })).toBe('blunder');
    });
  });

  describe('mate-логика', () => {
    it('cpAfter под мат (большое отрицательное) → blunder', () => {
      expect(
        classifyMove({ cpBefore: 50, cpAfter: -MATE_CP_BASE + 5 }),
      ).toBe('blunder');
    });

    it('cpAfter заматовал (большое положительное) → best', () => {
      expect(
        classifyMove({ cpBefore: 50, cpAfter: MATE_CP_BASE - 5 }),
      ).toBe('best');
    });

    it('заматовал даже из проигранной позиции → best', () => {
      // Контр-удар: вышли в выигрыш из тяжёлой позиции.
      expect(
        classifyMove({ cpBefore: -300, cpAfter: MATE_CP_BASE - 10 }),
      ).toBe('best');
    });
  });

  it('симметрия знаков: cpBefore=−100, cpAfter=−200 → потеря 100 → mistake', () => {
    // Если игрок был хуже на 100cp, и ухудшил до -200, потеря = 100,
    // больше 90 → mistake.
    expect(classifyMove({ cpBefore: -100, cpAfter: -200 })).toBe('mistake');
  });

  it('улучшил позицию (cpAfter > cpBefore) → best (cpLoss=0)', () => {
    expect(classifyMove({ cpBefore: -50, cpAfter: 100 })).toBe('best');
  });
});
