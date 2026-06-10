/**
 * KS-3074: regression-тест для `buildPrecisionScoreInputs` из
 * `PlayVsEngineRunner.tsx`. Жалоба пользователя: один и тот же пазл с
 * 3 best-ходами показывал 79% / 3★ в раннере и 100% / 5★ в истории.
 *
 * Корень: фронт не передавал `playedUci` / `bestUci` в
 * `computePrecisionScore`, поэтому KS-3030 best-override не срабатывал и
 * accuracy считалась по WDL, который у Stockfish между depths шумит
 * на единицы процентов. Backend же передавал UCI и получал 100/5★.
 *
 * Этот тест фиксирует контракт: с playedUci===bestUci сборка
 * `buildPrecisionScoreInputs` даёт массив, на котором
 * `computePrecisionScore` отдаёт ровно 100% / 5★, как backend.
 */
import { describe, it, expect } from 'vitest';
import { computePrecisionScore } from '@kingside/shared';
import { buildPrecisionScoreInputs } from './PlayVsEngineRunner';

// Шумный WDL — точно тот сценарий, что давал 79% до KS-3074.
// E_before = (480 + 460/2)/1000 = 0.710.
// E_after  = (470 + 440/2)/1000 = 0.690 → loss_E = 0.02 → accuracy ≈ 94%.
// Три таких хода без best-override дадут composite≈93, ниже 95-порога 5★.
const NOISY_BEFORE = { w: 480, d: 460, l: 60 };
const NOISY_AFTER = { w: 470, d: 440, l: 90 };

const THREE_BEST_LOG = [
  {
    wdlBefore: NOISY_BEFORE,
    wdlAfter: NOISY_AFTER,
    playedUci: 'a1a7',
    bestUci: 'a1a7', // best
  },
  {
    wdlBefore: NOISY_BEFORE,
    wdlAfter: NOISY_AFTER,
    playedUci: 'b2b4',
    bestUci: 'b2b4', // best
  },
  {
    wdlBefore: NOISY_BEFORE,
    wdlAfter: NOISY_AFTER,
    playedUci: 'f1b3',
    bestUci: 'f1b3', // best
  },
];

describe('KS-3074: buildPrecisionScoreInputs', () => {
  it('3 best-хода с WDL-jitter → 100% / 5★ (контракт жалобы)', () => {
    const inputs = buildPrecisionScoreInputs(THREE_BEST_LOG);
    // playedUci/bestUci обязаны быть проброшены — иначе репро вернётся.
    for (const inp of inputs) {
      expect(inp.playedUci).toBeDefined();
      expect(inp.bestUci).toBeDefined();
    }
    const result = computePrecisionScore(inputs);
    expect(result.stars).toBe(5);
    expect(result.scorePct).toBe(100);
  });

  it('без playedUci/bestUci (старое поведение) тот же лог давал < 100% — fail-safe для регрессии', () => {
    // Контр-пример: если кто-то откатит KS-3074 — этот тест поймает.
    const inputsBroken = THREE_BEST_LOG.map((m) => ({
      wdlBefore: m.wdlBefore,
      wdlAfter: m.wdlAfter,
      // playedUci/bestUci НЕ переданы — best-override KS-3030 не сработает.
    }));
    const result = computePrecisionScore(inputsBroken);
    expect(result.scorePct).not.toBe(100);
    expect(result.stars).not.toBe(5);
  });

  it('not-best ход без playedUci===bestUci учитывает WDL-loss как раньше', () => {
    const log = [
      {
        wdlBefore: { w: 700, d: 200, l: 100 },
        wdlAfter: { w: 300, d: 400, l: 300 },
        playedUci: 'd2d4',
        bestUci: 'e2e4', // НЕ best
      },
    ];
    const result = computePrecisionScore(buildPrecisionScoreInputs(log));
    // loss_E ≈ 0.25 → accuracy ≈ 31%, ни о каких 100% речи нет.
    expect(result.scorePct).toBeLessThan(50);
  });
});
