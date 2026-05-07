/**
 * KS-2547: тесты `isPrecisionSource`. Канонический `'precision'` +
 * silent backward-compat `'play-vs-engine'`. Любые другие — false.
 */
import { describe, it, expect } from 'vitest';
import { isPrecisionSource, PRECISION_SOURCE_VALUES } from './precisionSource';

describe('isPrecisionSource KS-2547', () => {
  it('возвращает true для канонического `precision`', () => {
    expect(isPrecisionSource('precision')).toBe(true);
  });

  it('возвращает true для backward-compat `play-vs-engine`', () => {
    expect(isPrecisionSource('play-vs-engine')).toBe(true);
  });

  it('возвращает false для других строк', () => {
    expect(isPrecisionSource('forced-line')).toBe(false);
    expect(isPrecisionSource('drills')).toBe(false);
    expect(isPrecisionSource('rush')).toBe(false);
    expect(isPrecisionSource('')).toBe(false);
  });

  it('null/undefined → false', () => {
    expect(isPrecisionSource(null)).toBe(false);
    expect(isPrecisionSource(undefined)).toBe(false);
  });

  it('PRECISION_SOURCE_VALUES содержит ровно 2 значения', () => {
    expect(PRECISION_SOURCE_VALUES).toHaveLength(2);
    expect(PRECISION_SOURCE_VALUES).toContain('precision');
    expect(PRECISION_SOURCE_VALUES).toContain('play-vs-engine');
  });
});
