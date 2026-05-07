/**
 * KS-2521 / KS-2528: тесты `wdlSignedToWinChancePercent` и
 * `permilleToPercent`. Покрываем границы диапазона, округление и
 * clamp при выходе за допустимые пределы.
 */
import { describe, it, expect } from 'vitest';
import {
  wdlSignedToWinChancePercent,
  permilleToPercent,
} from './chessFormat';

describe('wdlSignedToWinChancePercent KS-2521', () => {
  it('+1 (полная победа) → 100%', () => {
    expect(wdlSignedToWinChancePercent(1)).toBe(100);
  });

  it('0 (равенство) → 50%', () => {
    expect(wdlSignedToWinChancePercent(0)).toBe(50);
  });

  it('−1 (поражение) → 0%', () => {
    expect(wdlSignedToWinChancePercent(-1)).toBe(0);
  });

  it('+0.5 → 75%', () => {
    expect(wdlSignedToWinChancePercent(0.5)).toBe(75);
  });

  it('−0.5 → 25%', () => {
    expect(wdlSignedToWinChancePercent(-0.5)).toBe(25);
  });

  it('clamp при wdl > +1', () => {
    expect(wdlSignedToWinChancePercent(1.05)).toBe(100);
    expect(wdlSignedToWinChancePercent(2)).toBe(100);
  });

  it('clamp при wdl < −1', () => {
    expect(wdlSignedToWinChancePercent(-1.05)).toBe(0);
    expect(wdlSignedToWinChancePercent(-2)).toBe(0);
  });

  it('возвращает целое в [0..100]', () => {
    for (const w of [-0.7, -0.3, 0.123, 0.56, 0.89]) {
      const r = wdlSignedToWinChancePercent(w);
      expect(Number.isInteger(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(100);
    }
  });
});

describe('permilleToPercent KS-2528', () => {
  it('1000 → 100', () => {
    expect(permilleToPercent(1000)).toBe(100);
  });

  it('0 → 0', () => {
    expect(permilleToPercent(0)).toBe(0);
  });

  it('500 → 50', () => {
    expect(permilleToPercent(500)).toBe(50);
  });

  it('850 → 85, 196 → 20 (округление)', () => {
    expect(permilleToPercent(850)).toBe(85);
    expect(permilleToPercent(196)).toBe(20);
  });

  it('clamp выпадений за диапазон', () => {
    expect(permilleToPercent(1100)).toBe(100);
    expect(permilleToPercent(-50)).toBe(0);
  });

  it('Math.round (995 → 100, 4 → 0)', () => {
    expect(permilleToPercent(995)).toBe(100);
    expect(permilleToPercent(4)).toBe(0);
  });
});
