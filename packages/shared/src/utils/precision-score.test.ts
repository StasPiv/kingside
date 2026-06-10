/**
 * KS-2997 / KS-3774. Тесты `computePrecisionScore`.
 *
 * После KS-3774 расчёт точности опирается ТОЛЬКО на изменение
 * expected-score (E = (w + d/2) / 1000) между стартовой и конечной
 * позициями. Прежний композит mean+min + worst-class cap из ADR-065
 * §3.4 удалён, тесты на него — тоже.
 */
import { describe, it, expect } from 'vitest';
import {
  CLASSIFICATION_FALLBACK_ACCURACY,
  COMPOSITE_MEAN_WEIGHT,
  COMPOSITE_MIN_WEIGHT,
  MIN_HALF_MOVES_FOR_SCORE,
  STAR_THRESHOLDS,
  WORST_CLASS_CAP,
  accuracyMove,
  computePrecisionScore,
  computeStartExpectedScore,
  computeEndExpectedScore,
  precisionFromExpectedScoreDelta,
  mapToStars,
  winPctFromCp,
  worstClassification,
  type PrecisionMoveClass,
  type PrecisionMoveInput,
} from './precision-score.js';

/** Удобный конструктор «идеального» хода (wdl=1000,0,0). */
function perfectWdl(): PrecisionMoveInput {
  return {
    wdlBefore: { w: 1000, d: 0, l: 0 },
    wdlAfter: { w: 1000, d: 0, l: 0 },
    classification: 'best',
  };
}

/**
 * Конструктор хода с заданной WDL-loss в п.п. ΔE * 100. Стартовая
 * E = 1.0 (wdl=1000,0,0), конечная E = 1 - lossPct/100.
 */
function wdlMoveWithLoss(lossPct: number, klass?: PrecisionMoveClass): PrecisionMoveInput {
  const eAfter = Math.max(0, 1 - lossPct / 100);
  const lossPerMille = Math.round((1 - eAfter) * 1000);
  return {
    wdlBefore: { w: 1000, d: 0, l: 0 },
    wdlAfter: {
      w: 1000 - lossPerMille,
      d: 0,
      l: lossPerMille,
    },
    ...(klass ? { classification: klass } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────
// KS-3774: главный сценарий из задачи #b846db34
// ─────────────────────────────────────────────────────────────────

describe('KS-3774: расчёт точности по WDL-дельте (задача #b846db34)', () => {
  it('1.00 → 0.62 (W 100→24, D 0→76) даёт очень низкую точность (1★, scorePct < 30)', () => {
    // Воспроизведение скриншота: победа 100% → 24%, ничья 0% → 76%.
    // startE = (1000 + 0/2) / 1000 = 1.00.
    // endE   = (240  + 760/2) / 1000 = 0.62.
    // loss_E = 0.38, scorePct ≈ 103.1668 * exp(-0.04354*38) - 3.1669
    //        ≈ 103.1668 * 0.1913 - 3.1669 ≈ 16.57 → 1★.
    const moves: PrecisionMoveInput[] = [
      {
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 240, d: 760, l: 0 },
        // classification намеренно best — старая методика дала бы 5★
        // (best-override), KS-3774 НЕ должна на это смотреть.
        classification: 'best',
        isBestMove: true,
      },
    ];
    const r = computePrecisionScore(moves);
    expect(r.stars).toBe(1);
    expect(r.scorePct).not.toBeNull();
    expect(r.scorePct!).toBeLessThan(30);
    expect(r.scorePct!).toBeGreaterThan(10);
  });

  it('NAG `best` на ходе НЕ перебивает падение WDL: классификации игнорируются', () => {
    // Серия «лучших» ходов, но позиция объективно ушла:
    // 1.00 → 0.62. По старой методике с best-override был бы 5★.
    // По KS-3774 — 1★.
    const moves: PrecisionMoveInput[] = [
      {
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 800, d: 200, l: 0 },
        classification: 'best',
        isBestMove: true,
      },
      {
        wdlBefore: { w: 800, d: 200, l: 0 },
        wdlAfter: { w: 500, d: 500, l: 0 },
        classification: 'best',
        isBestMove: true,
      },
      {
        wdlBefore: { w: 500, d: 500, l: 0 },
        wdlAfter: { w: 240, d: 760, l: 0 },
        classification: 'best',
        isBestMove: true,
      },
    ];
    const r = computePrecisionScore(moves);
    expect(r.stars).toBe(1);
    expect(r.scorePct!).toBeLessThan(30);
  });

  it('сохранил перевес (1.00 → 1.00) → 5★, scorePct=100', () => {
    const r = computePrecisionScore([perfectWdl()]);
    expect(r.stars).toBe(5);
    expect(r.scorePct).toBeCloseTo(100, 2);
  });

  it('улучшил позицию (E_end > E_start) → 5★, loss_E=0', () => {
    const moves: PrecisionMoveInput[] = [
      {
        wdlBefore: { w: 600, d: 300, l: 100 }, // E = 0.75
        wdlAfter: { w: 900, d: 100, l: 0 }, // E = 0.95
      },
    ];
    const r = computePrecisionScore(moves);
    expect(r.stars).toBe(5);
    expect(r.scorePct).toBeCloseTo(100, 2);
  });

  it('полный blunder (1.00 → 0.00) → 1★, scorePct ≈ 0', () => {
    const moves: PrecisionMoveInput[] = [
      {
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 0, d: 0, l: 1000 },
      },
    ];
    const r = computePrecisionScore(moves);
    expect(r.stars).toBe(1);
    expect(r.scorePct!).toBeLessThan(5);
  });
});

// ─────────────────────────────────────────────────────────────────
// computeStartExpectedScore / computeEndExpectedScore
// ─────────────────────────────────────────────────────────────────

describe('KS-3774: computeStartExpectedScore', () => {
  it('берёт первый wdlBefore', () => {
    const moves: PrecisionMoveInput[] = [
      { wdlBefore: { w: 800, d: 200, l: 0 }, wdlAfter: null },
      { wdlBefore: { w: 0, d: 0, l: 1000 }, wdlAfter: null },
    ];
    expect(computeStartExpectedScore(moves)).toBeCloseTo(0.9, 4);
  });

  it('null если нет wdlBefore ни у одного хода', () => {
    expect(
      computeStartExpectedScore([{ wdlBefore: null }]),
    ).toBeNull();
  });
});

describe('KS-3774: computeEndExpectedScore', () => {
  it('берёт wdlAfter с последнего хода', () => {
    const moves: PrecisionMoveInput[] = [
      { wdlAfter: { w: 800, d: 200, l: 0 } },
      { wdlAfter: { w: 240, d: 760, l: 0 } },
    ];
    expect(computeEndExpectedScore(moves)).toBeCloseTo(0.62, 4);
  });

  it('null если нет wdlAfter ни у одного хода', () => {
    expect(computeEndExpectedScore([{ wdlAfter: null }])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// precisionFromExpectedScoreDelta
// ─────────────────────────────────────────────────────────────────

describe('KS-3774: precisionFromExpectedScoreDelta', () => {
  it('loss_E = 0 (start = end) → 100', () => {
    expect(precisionFromExpectedScoreDelta(0.75, 0.75)).toBeCloseTo(100, 2);
  });

  it('loss_E < 0 (улучшение) → 100, не штрафуем', () => {
    expect(precisionFromExpectedScoreDelta(0.5, 0.8)).toBeCloseTo(100, 2);
  });

  it('loss_E = 0.38 (кейс задачи) → ≈ 16-20, попадает в 1★', () => {
    const s = precisionFromExpectedScoreDelta(1.0, 0.62);
    expect(s).toBeGreaterThan(10);
    expect(s).toBeLessThan(30);
    expect(mapToStars(s)).toBe(1);
  });

  it('loss_E = 0.10 → ≈ 63-68, попадает в 2★', () => {
    const s = precisionFromExpectedScoreDelta(0.85, 0.75);
    expect(s).toBeGreaterThan(60);
    expect(s).toBeLessThan(70);
    expect(mapToStars(s)).toBe(2);
  });

  it('loss_E = 0.05 → ≈ 80, попадает в 3★', () => {
    const s = precisionFromExpectedScoreDelta(0.80, 0.75);
    expect(s).toBeGreaterThan(78);
    expect(s).toBeLessThan(85);
    expect(mapToStars(s)).toBe(3);
  });

  it('loss_E = 1.0 (полный обвал) → ≈ 0', () => {
    const s = precisionFromExpectedScoreDelta(1.0, 0.0);
    expect(s).toBeLessThan(5);
    expect(mapToStars(s)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// computePrecisionScore — edge cases
// ─────────────────────────────────────────────────────────────────

describe('computePrecisionScore — edge cases', () => {
  it('length=0 → null', () => {
    const r = computePrecisionScore([]);
    expect(r.stars).toBeNull();
    expect(r.scorePct).toBeNull();
  });

  it('нет WDL ни на старте, ни в конце → null', () => {
    const moves: PrecisionMoveInput[] = [
      { wdlBefore: null, wdlAfter: null },
    ];
    const r = computePrecisionScore(moves);
    expect(r.stars).toBeNull();
    expect(r.scorePct).toBeNull();
  });

  it('многоходовка: учитывается первый wdlBefore и последний wdlAfter', () => {
    // Промежуточные wdl-данные при расчёте игнорируются.
    const moves: PrecisionMoveInput[] = [
      {
        wdlBefore: { w: 1000, d: 0, l: 0 }, // start
        wdlAfter: { w: 600, d: 400, l: 0 }, // промежуток — не используется
      },
      {
        wdlBefore: { w: 600, d: 400, l: 0 }, // промежуток — не используется
        wdlAfter: { w: 240, d: 760, l: 0 }, // end
      },
    ];
    const r = computePrecisionScore(moves);
    expect(r.stars).toBe(1);
    // startE=1.00, endE=0.62 — те же, что и в одиночном кейсе.
    expect(r.scorePct!).toBeLessThan(30);
  });
});

// ─────────────────────────────────────────────────────────────────
// per-move helpers (accuracyMove / winPctFromCp / mapToStars /
// worstClassification) — сохранены для NAG-разметки в других местах,
// проверяем что они продолжают работать как прежде.
// ─────────────────────────────────────────────────────────────────

describe('accuracyMove (helper для NAG-разметки)', () => {
  it('WDL: loss=0 (E_before=E_after=1.0) → accuracy ≈ 100', () => {
    expect(accuracyMove(perfectWdl())).toBeCloseTo(100, 2);
  });

  it('WDL: loss=50% (E_after=0.5) → accuracy ≈ 8.5', () => {
    const a = accuracyMove(wdlMoveWithLoss(50));
    expect(a!).toBeGreaterThan(7);
    expect(a!).toBeLessThan(11);
  });

  it('best-override (classification=best) → 100', () => {
    expect(accuracyMove({ classification: 'best' })).toBe(100);
  });

  it('classification fallback: good → 80, blunder → 5', () => {
    expect(accuracyMove({ classification: 'good' })).toBe(80);
    expect(accuracyMove({ classification: 'blunder' })).toBe(5);
  });

  it('нет ни WDL, ни classification → null', () => {
    expect(accuracyMove({})).toBeNull();
  });
});

describe('winPctFromCp', () => {
  it('cp=0 → 50%', () => {
    expect(winPctFromCp(0)).toBeCloseTo(50, 4);
  });

  it('cp=+300 → ≈ 75%', () => {
    expect(winPctFromCp(300)).toBeGreaterThan(70);
    expect(winPctFromCp(300)).toBeLessThan(80);
  });

  it('cp=-300 → антисимметрично', () => {
    expect(winPctFromCp(300) + winPctFromCp(-300)).toBeCloseTo(100, 4);
  });

  it('экстремальный cp клампится в [0, 100]', () => {
    expect(winPctFromCp(10000)).toBeLessThanOrEqual(100);
    expect(winPctFromCp(-10000)).toBeGreaterThanOrEqual(0);
  });
});

describe('mapToStars — границы 50/70/85/95', () => {
  it('95+ → 5★, 94.99 → 4★', () => {
    expect(mapToStars(100)).toBe(5);
    expect(mapToStars(95)).toBe(5);
    expect(mapToStars(94.99)).toBe(4);
  });
  it('85-94.99 → 4★', () => {
    expect(mapToStars(85)).toBe(4);
    expect(mapToStars(84.99)).toBe(3);
  });
  it('70-84.99 → 3★', () => {
    expect(mapToStars(70)).toBe(3);
    expect(mapToStars(69.99)).toBe(2);
  });
  it('50-69.99 → 2★', () => {
    expect(mapToStars(50)).toBe(2);
    expect(mapToStars(49.99)).toBe(1);
  });
  it('< 50 → 1★', () => {
    expect(mapToStars(25)).toBe(1);
  });
});

describe('worstClassification (helper для NAG-разметки)', () => {
  it('best + mistake → mistake', () => {
    expect(
      worstClassification([
        { classification: 'best' },
        { classification: 'mistake' },
      ]),
    ).toBe('mistake');
  });

  it('moves без classification → null', () => {
    expect(worstClassification([{ wdlBefore: null }])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Константы — sanity check
// ─────────────────────────────────────────────────────────────────

describe('Константы', () => {
  it('STAR_THRESHOLDS монотонные', () => {
    expect(STAR_THRESHOLDS.two).toBeLessThan(STAR_THRESHOLDS.three);
    expect(STAR_THRESHOLDS.three).toBeLessThan(STAR_THRESHOLDS.four);
    expect(STAR_THRESHOLDS.four).toBeLessThan(STAR_THRESHOLDS.five);
  });

  it('COMPOSITE_*_WEIGHT в сумме = 1.0 (legacy константа, для совместимости импортов)', () => {
    expect(COMPOSITE_MEAN_WEIGHT + COMPOSITE_MIN_WEIGHT).toBeCloseTo(1, 6);
  });

  it('WORST_CLASS_CAP (legacy, не используется в новой методике)', () => {
    expect(WORST_CLASS_CAP.blunder).toBeLessThan(STAR_THRESHOLDS.three);
    expect(WORST_CLASS_CAP.mistake).toBeLessThan(STAR_THRESHOLDS.four);
  });

  it('CLASSIFICATION_FALLBACK_ACCURACY монотонная', () => {
    expect(CLASSIFICATION_FALLBACK_ACCURACY.best).toBeGreaterThan(
      CLASSIFICATION_FALLBACK_ACCURACY.good,
    );
    expect(CLASSIFICATION_FALLBACK_ACCURACY.mistake).toBeGreaterThan(
      CLASSIFICATION_FALLBACK_ACCURACY.blunder,
    );
  });

  it('MIN_HALF_MOVES_FOR_SCORE >= 1', () => {
    expect(MIN_HALF_MOVES_FOR_SCORE).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// KS-3246: evaluateObjectiveAchieved / computeAttemptObjectiveAchieved /
// computeVerdictKey — не меняются KS-3774, тесты сохранены.
// ─────────────────────────────────────────────────────────────────

import {
  evaluateObjectiveAchieved,
  computeAttemptObjectiveAchieved,
  computeVerdictKey,
  OBJECTIVE_TOLERANCE,
} from './precision-score.js';

describe('KS-3246 evaluateObjectiveAchieved', () => {
  describe('convertAdvantage (tolerance=0.02)', () => {
    it('end_E > start_E → true', () => {
      expect(evaluateObjectiveAchieved(0.75, 0.87, 'convertAdvantage')).toBe(true);
    });
    it('end_E = start_E → true', () => {
      expect(evaluateObjectiveAchieved(0.8, 0.8, 'convertAdvantage')).toBe(true);
    });
    it('end_E = start_E − 0.02 (граница) → true', () => {
      expect(evaluateObjectiveAchieved(0.8, 0.78, 'convertAdvantage')).toBe(true);
    });
    it('end_E = start_E − 0.03 → false', () => {
      expect(evaluateObjectiveAchieved(0.8, 0.77, 'convertAdvantage')).toBe(false);
    });
  });

  describe('saveEquality (tolerance=0.05)', () => {
    it('end_E = start_E − 0.05 (граница) → true', () => {
      expect(evaluateObjectiveAchieved(0.5, 0.45, 'saveEquality')).toBe(true);
    });
    it('end_E = start_E − 0.06 → false', () => {
      expect(evaluateObjectiveAchieved(0.5, 0.44, 'saveEquality')).toBe(false);
    });
  });

  it('null/undefined аргумент → null', () => {
    expect(evaluateObjectiveAchieved(null, 0.5, 'convertAdvantage')).toBeNull();
    expect(evaluateObjectiveAchieved(0.5, null, 'saveEquality')).toBeNull();
  });

  it('NaN → null', () => {
    expect(evaluateObjectiveAchieved(NaN, 0.5, 'convertAdvantage')).toBeNull();
  });

  it('OBJECTIVE_TOLERANCE экспортирован', () => {
    expect(OBJECTIVE_TOLERANCE.convertAdvantage).toBe(0.02);
    expect(OBJECTIVE_TOLERANCE.saveEquality).toBe(0.05);
  });
});

describe('KS-3246 computeAttemptObjectiveAchieved', () => {
  it('convertAdvantage, ΔE > 0 → true', () => {
    const moves: PrecisionMoveInput[] = [
      {
        wdlBefore: { w: 750, d: 250, l: 0 },
        wdlAfter: { w: 870, d: 130, l: 0 },
      },
    ];
    expect(computeAttemptObjectiveAchieved(moves, 'convertAdvantage')).toBe(true);
  });

  it('saveEquality, ΔE < −0.05 → false', () => {
    const moves: PrecisionMoveInput[] = [
      {
        wdlBefore: { w: 0, d: 590, l: 410 },
        wdlAfter: { w: 0, d: 460, l: 540 },
      },
    ];
    expect(computeAttemptObjectiveAchieved(moves, 'saveEquality')).toBe(false);
  });

  it('пустой массив → null', () => {
    expect(computeAttemptObjectiveAchieved([], 'saveEquality')).toBeNull();
  });
});

describe('KS-3246 computeVerdictKey', () => {
  it('null stars → null verdict', () => {
    expect(computeVerdictKey(null, true)).toBeNull();
  });

  it('GOAL_ACHIEVED=true: 5★→flawless, 4★→confident, ..., 1★→with-blunders', () => {
    expect(computeVerdictKey(5, true)).toBe('flawless');
    expect(computeVerdictKey(4, true)).toBe('confident');
    expect(computeVerdictKey(3, true)).toBe('suboptimal');
    expect(computeVerdictKey(2, true)).toBe('with-mistakes');
    expect(computeVerdictKey(1, true)).toBe('with-blunders');
  });

  it('GOAL_ACHIEVED=false: 4★→goal-missed-clean, ..., 1★→goal-missed-blunders', () => {
    expect(computeVerdictKey(5, false)).toBe('flawless');
    expect(computeVerdictKey(4, false)).toBe('goal-missed-clean');
    expect(computeVerdictKey(3, false)).toBe('goal-missed');
    expect(computeVerdictKey(2, false)).toBe('goal-missed-mistakes');
    expect(computeVerdictKey(1, false)).toBe('goal-missed-blunders');
  });

  it('GOAL_ACHIEVED=null → ведём как true', () => {
    expect(computeVerdictKey(3, null)).toBe('suboptimal');
  });
});
