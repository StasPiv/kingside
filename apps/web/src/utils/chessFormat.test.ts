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

/**
 * KS-2677 — acceptance: для проигранной стороны win-chance ≤ 20%.
 *
 * Сценарий из задачи: eval = -1.86 (POV white, side-to-move=white).
 * Lichess-сигмоида: `winning_chances = 2/(1+exp(-0.004 * cp)) - 1`.
 * При cp=-186 это ≈ -0.55 (приблизительная аппроксимация без эндшпильных
 * поправок). Итог через wdlSignedToWinChancePercent должен быть ≤ 20%.
 *
 * Тест НЕ покрывает разворот POV в генераторе пазлов (этим занимается
 * `puzzleGenerator.test.ts`); проверяет только конвертацию signed-WDL
 * → win% работает корректно для отрицательных значений (т.е. для
 * стороны, чьи шансы на победу действительно низкие).
 */
describe('wdlSignedToWinChancePercent KS-2677 — для проигрывающей стороны', () => {
  it('Stockfish-WDL POV проигрывающего (типично для cp ≈ -186): w=50, d=200, l=750 → ≤ 20%', () => {
    // Реальный Stockfish 15.1 на позициях с cp ≈ -186 (POV side-to-move)
    // отдаёт распределение около (W=50, D=200, L=750). wdl_signed =
    // (50 - 750) / 1000 = -0.7. Это «у проигрывающей стороны 15% шансов».
    const wdlSigned = (50 - 750) / 1000;
    const pct = wdlSignedToWinChancePercent(wdlSigned);
    expect(pct).toBeLessThanOrEqual(20);
    expect(pct).toBe(15); // ((-0.7 + 1) / 2) * 100 = 15
  });

  it('Симметрия: POV выигрывающего (зеркало) → ≥ 80%', () => {
    // Если у проигрывающего ≤ 20%, то у выигрывающего (с противоположным
    // знаком signed-WDL) должно быть ≥ 80%. Это критерий «обе стороны
    // в одной системе координат» из KS-2677 #3.
    const wdlLoser = -0.7;
    const wdlWinner = -wdlLoser;
    const loserPct = wdlSignedToWinChancePercent(wdlLoser);
    const winnerPct = wdlSignedToWinChancePercent(wdlWinner);
    expect(loserPct + winnerPct).toBe(100);
    expect(winnerPct).toBeGreaterThanOrEqual(80);
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
