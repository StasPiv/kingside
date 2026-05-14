/**
 * KS-2997 / ADR-065 §4.3 B1. Тесты `computePrecisionScore`.
 *
 * Покрытие:
 *  - 9 контрольных кейсов из ADR-065 §4.3 (через `aggregateAccuracies` —
 *    прямой контроль композита и cap'а без построения wdl-входов).
 *  - `accuracyMove`: WDL → loss=0 → 100, mid-loss; cp → fallback;
 *    classification → fallback.
 *  - `winPctFromCp`: контрольные точки (-300, 0, +300).
 *  - `mapToStars`: границы 50/70/85/95.
 *  - `worstClassification`: пустой / mixed.
 *  - `computePrecisionScore`: end-to-end на синтетических WDL,
 *    + edge: length=0, length=1, all-NULL, >50% gaps.
 */
import { describe, it, expect } from 'vitest';
import {
  CLASSIFICATION_FALLBACK_ACCURACY,
  COMPOSITE_MEAN_WEIGHT,
  COMPOSITE_MIN_WEIGHT,
  MIN_DATA_FRACTION,
  MIN_HALF_MOVES_FOR_SCORE,
  STAR_THRESHOLDS,
  WORST_CLASS_CAP,
  accuracyMove,
  aggregateAccuracies,
  computePrecisionScore,
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
 * Для loss=0% → accuracy ≈ 100. Для loss=50% → accuracy ≈ 8.
 */
function wdlMoveWithLoss(lossPct: number, klass?: PrecisionMoveClass): PrecisionMoveInput {
  const eAfter = Math.max(0, 1 - lossPct / 100);
  // Распределяем (1-eAfter) на loss-баскет.
  const lossPerMille = Math.round((1 - eAfter) * 1000);
  return {
    wdlBefore: { w: 1000, d: 0, l: 0 },
    wdlAfter: {
      w: 1000 - lossPerMille,
      d: 0,
      l: lossPerMille,
    },
    classification: klass ?? 'best',
  };
}

// ─────────────────────────────────────────────────────────────────
// 9 контрольных кейсов ADR-065 §4.3
// ─────────────────────────────────────────────────────────────────

describe('ADR-065 §4.3: 9 контрольных кейсов', () => {
  it('#1 — 6 best → 100% → ★★★★★', () => {
    const r = aggregateAccuracies([100, 100, 100, 100, 100, 100], 'best');
    expect(r.scorePct).toBeCloseTo(100, 4);
    expect(r.stars).toBe(5);
  });

  it('#2 — 5 best + 1 good (accuracy=82) → 92.5% → ★★★★', () => {
    const r = aggregateAccuracies([100, 100, 100, 100, 100, 82], 'good');
    // mean = (5*100 + 82)/6 = 97; min = 82; 0.7*97 + 0.3*82 = 67.9+24.6 = 92.5.
    expect(r.scorePct).toBeCloseTo(92.5, 4);
    expect(r.stars).toBe(4);
  });

  it('#3 — 5 best + 1 inaccuracy (accuracy=60) → 83.3% → ★★★', () => {
    const r = aggregateAccuracies([100, 100, 100, 100, 100, 60], 'inaccuracy');
    // mean = (5*100+60)/6 = 93.333; min = 60; 0.7*93.333+0.3*60 = 83.333.
    expect(r.scorePct).toBeCloseTo(83.333, 2);
    expect(r.stars).toBe(3);
  });

  it('#4 — 4 best + 2 inaccuracy → 78.7% → ★★★', () => {
    const r = aggregateAccuracies([100, 100, 100, 100, 60, 60], 'inaccuracy');
    // mean = (4*100+2*60)/6 = 86.667; min=60; 0.7*86.667+0.3*60 = 78.667.
    expect(r.scorePct).toBeCloseTo(78.667, 2);
    expect(r.stars).toBe(3);
  });

  it('#5 — 5 best + 1 mistake (accuracy=25) → 68.75% (без cap) → ★★', () => {
    const r = aggregateAccuracies([100, 100, 100, 100, 100, 25], 'mistake');
    // mean=87.5; min=25; 0.7*87.5+0.3*25 = 61.25+7.5 = 68.75.
    // cap=mistake=80, но 68.75 < 80 — cap не активируется (страховочный).
    expect(r.scorePct).toBeCloseTo(68.75, 4);
    expect(r.stars).toBe(2);
  });

  it('#6 — 5 best + 1 blunder (accuracy=5) → cap=60 → ★★', () => {
    const r = aggregateAccuracies([100, 100, 100, 100, 100, 5], 'blunder');
    // composite = 0.7*84.167+0.3*5 = 58.917+1.5 = 60.417, cap=60 → 60.
    expect(r.scorePct).toBe(60);
    expect(r.stars).toBe(2);
  });

  it('#7 — 9 best + 1 blunder → cap=60 → ★★ (длинная линия не спасает)', () => {
    const r = aggregateAccuracies(
      [100, 100, 100, 100, 100, 100, 100, 100, 100, 5],
      'blunder',
    );
    // mean=90.5; min=5; composite=0.7*90.5+0.3*5=63.35+1.5=64.85 → cap=60.
    expect(r.scorePct).toBe(60);
    expect(r.stars).toBe(2);
  });

  it('#8 — 2 best + 2 blunder + 2 best → 49.3% → ★', () => {
    const r = aggregateAccuracies([100, 100, 5, 5, 100, 100], 'blunder');
    // mean=68.333; min=5; composite=0.7*68.333+0.3*5=47.833+1.5=49.333.
    // cap=60, не активен (49.333 < 60).
    expect(r.scorePct).toBeCloseTo(49.333, 2);
    expect(r.stars).toBe(1);
  });

  it('#9 — длинная идеальная (12 best) → 100 → ★★★★★', () => {
    const r = aggregateAccuracies(new Array(12).fill(100), 'best');
    expect(r.scorePct).toBeCloseTo(100, 4);
    expect(r.stars).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────
// accuracyMove — все три ветки (WDL, cp, classification)
// ─────────────────────────────────────────────────────────────────

describe('accuracyMove', () => {
  it('WDL: loss=0 (E_before=E_after=1.0) → accuracy ≈ 100', () => {
    const a = accuracyMove(perfectWdl());
    expect(a).toBeCloseTo(100, 2);
  });

  it('WDL: loss=50% (E_after=0.5) → accuracy ≈ 8.5 (катастрофа)', () => {
    const a = accuracyMove(wdlMoveWithLoss(50));
    // 103.1668*exp(-2.177)-3.1669 ≈ 103.1668*0.1135-3.1669 ≈ 8.5.
    expect(a).toBeGreaterThan(7);
    expect(a).toBeLessThan(11);
  });

  it('WDL имеет приоритет над cp (если оба заданы)', () => {
    // wdl даёт loss=0 → accuracy=100; cp намеренно «плохой».
    const a = accuracyMove({
      wdlBefore: { w: 1000, d: 0, l: 0 },
      wdlAfter: { w: 1000, d: 0, l: 0 },
      cpBefore: 1000,
      cpAfter: -1000, // если бы пошли по cp-ветке, было бы ≈ 0
    });
    expect(a).toBeCloseTo(100, 2);
  });

  it('cp-fallback: cpBefore=300, cpAfter=0 → accuracy ≈ 31', () => {
    const a = accuracyMove({
      wdlBefore: null,
      wdlAfter: null,
      cpBefore: 300,
      cpAfter: 0,
    });
    // winBefore≈75.1, winAfter=50, loss≈25.1, exp-formula ≈ 31.
    expect(a).toBeGreaterThan(28);
    expect(a).toBeLessThan(35);
  });

  it('cp-fallback: cp не уменьшился → loss=0 → accuracy ≈ 100', () => {
    const a = accuracyMove({
      cpBefore: 100,
      cpAfter: 200, // ход не ухудшил позицию, наоборот
    });
    expect(a).toBeCloseTo(100, 1);
  });

  it('classification fallback: best → 95, blunder → 5', () => {
    expect(
      accuracyMove({ wdlBefore: null, classification: 'best' }),
    ).toBe(95);
    expect(
      accuracyMove({ wdlBefore: null, classification: 'blunder' }),
    ).toBe(5);
  });

  it('нет ни wdl, ни cp, ни classification → null', () => {
    const a = accuracyMove({});
    expect(a).toBeNull();
  });

  it('clamp: огромный отрицательный cp-loss не даёт > 100', () => {
    const a = accuracyMove({ cpBefore: -1000, cpAfter: 1000 });
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(100);
  });
});

// ─────────────────────────────────────────────────────────────────
// winPctFromCp — Lichess CP→Win formula
// ─────────────────────────────────────────────────────────────────

describe('winPctFromCp', () => {
  it('cp=0 → 50% (равная позиция)', () => {
    expect(winPctFromCp(0)).toBeCloseTo(50, 4);
  });

  it('cp=+300 → ≈ 75%', () => {
    expect(winPctFromCp(300)).toBeGreaterThan(70);
    expect(winPctFromCp(300)).toBeLessThan(80);
  });

  it('cp=-300 → ≈ 25% (симметрия)', () => {
    expect(winPctFromCp(-300)).toBeGreaterThan(20);
    expect(winPctFromCp(-300)).toBeLessThan(30);
    // Сумма ровно 100 (антисимметричность).
    expect(winPctFromCp(300) + winPctFromCp(-300)).toBeCloseTo(100, 4);
  });

  it('экстремальный cp клампится в [0, 100]', () => {
    expect(winPctFromCp(10000)).toBeLessThanOrEqual(100);
    expect(winPctFromCp(-10000)).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// mapToStars — границы 50/70/85/95
// ─────────────────────────────────────────────────────────────────

describe('mapToStars', () => {
  it('95+ → 5★, 94.99 → 4★', () => {
    expect(mapToStars(100)).toBe(5);
    expect(mapToStars(95)).toBe(5);
    expect(mapToStars(94.99)).toBe(4);
  });

  it('85-94.99 → 4★', () => {
    expect(mapToStars(85)).toBe(4);
    expect(mapToStars(90)).toBe(4);
    expect(mapToStars(84.99)).toBe(3);
  });

  it('70-84.99 → 3★', () => {
    expect(mapToStars(70)).toBe(3);
    expect(mapToStars(78)).toBe(3);
    expect(mapToStars(69.99)).toBe(2);
  });

  it('50-69.99 → 2★', () => {
    expect(mapToStars(50)).toBe(2);
    expect(mapToStars(60)).toBe(2);
    expect(mapToStars(49.99)).toBe(1);
  });

  it('< 50 → 1★', () => {
    expect(mapToStars(0)).toBe(1);
    expect(mapToStars(25)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// worstClassification — порядок best < good < inaccuracy < mistake < blunder
// ─────────────────────────────────────────────────────────────────

describe('worstClassification', () => {
  it('пустой массив → null', () => {
    expect(worstClassification([])).toBeNull();
  });

  it('все best → best', () => {
    expect(
      worstClassification([
        { classification: 'best' },
        { classification: 'best' },
      ]),
    ).toBe('best');
  });

  it('best + mistake → mistake', () => {
    expect(
      worstClassification([
        { classification: 'best' },
        { classification: 'mistake' },
        { classification: 'best' },
      ]),
    ).toBe('mistake');
  });

  it('один blunder среди good — выбирается blunder', () => {
    expect(
      worstClassification([
        { classification: 'good' },
        { classification: 'good' },
        { classification: 'blunder' },
      ]),
    ).toBe('blunder');
  });

  it('moves без classification → null', () => {
    expect(
      worstClassification([
        { wdlBefore: null },
        { wdlBefore: null },
      ]),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// computePrecisionScore — end-to-end + edge cases (ADR §3.4)
// ─────────────────────────────────────────────────────────────────

describe('computePrecisionScore — end-to-end', () => {
  it('6 идеальных WDL ходов → ★★★★★, scorePct ≈ 100', () => {
    const moves: PrecisionMoveInput[] = new Array(6).fill(null).map(() =>
      perfectWdl(),
    );
    const r = computePrecisionScore(moves);
    expect(r.stars).toBe(5);
    expect(r.scorePct).toBeCloseTo(100, 1);
  });

  it('5 идеальных + 1 blunder с большим loss → cap до 60 → ★★', () => {
    const moves: PrecisionMoveInput[] = [
      ...new Array(5).fill(null).map(() => perfectWdl()),
      wdlMoveWithLoss(60, 'blunder'),
    ];
    const r = computePrecisionScore(moves);
    expect(r.stars).toBe(2);
    expect(r.scorePct).toBe(60);
  });

  it('classification-fallback: ходы без WDL/cp с classification', () => {
    const moves: PrecisionMoveInput[] = [
      { classification: 'best' },
      { classification: 'best' },
      { classification: 'good' },
      { classification: 'inaccuracy' },
    ];
    // accuracies = [95, 95, 80, 55]; mean=81.25; min=55; composite=73.375.
    // worst=inaccuracy → no cap. mapToStars(73.375) = 3.
    const r = computePrecisionScore(moves);
    expect(r.stars).toBe(3);
    expect(r.scorePct).toBeCloseTo(73.375, 2);
  });
});

describe('computePrecisionScore — edge cases (ADR §3.4)', () => {
  it('length=0 → null', () => {
    const r = computePrecisionScore([]);
    expect(r.stars).toBeNull();
    expect(r.scorePct).toBeNull();
  });

  it('length=1 → null (< MIN_HALF_MOVES_FOR_SCORE)', () => {
    const r = computePrecisionScore([perfectWdl()]);
    expect(r.stars).toBeNull();
    expect(r.scorePct).toBeNull();
  });

  it('все ходы без данных (wdl=cp=classification=null) → null', () => {
    const moves: PrecisionMoveInput[] = [
      { wdlBefore: null, wdlAfter: null, cpBefore: null, cpAfter: null },
      { wdlBefore: null, wdlAfter: null, cpBefore: null, cpAfter: null },
      { wdlBefore: null, wdlAfter: null, cpBefore: null, cpAfter: null },
    ];
    const r = computePrecisionScore(moves);
    expect(r.stars).toBeNull();
    expect(r.scorePct).toBeNull();
  });

  it('> 50% gaps: 1 из 4 ходов с данными → null', () => {
    const moves: PrecisionMoveInput[] = [
      perfectWdl(),
      { wdlBefore: null, wdlAfter: null, cpBefore: null, cpAfter: null },
      { wdlBefore: null, wdlAfter: null, cpBefore: null, cpAfter: null },
      { wdlBefore: null, wdlAfter: null, cpBefore: null, cpAfter: null },
    ];
    const r = computePrecisionScore(moves);
    expect(r.stars).toBeNull();
    expect(r.scorePct).toBeNull();
  });

  it('ровно 50% gaps: 2 из 4 — НЕ null (граница ≥)', () => {
    const moves: PrecisionMoveInput[] = [
      perfectWdl(),
      perfectWdl(),
      { wdlBefore: null, wdlAfter: null, cpBefore: null, cpAfter: null },
      { wdlBefore: null, wdlAfter: null, cpBefore: null, cpAfter: null },
    ];
    const r = computePrecisionScore(moves);
    expect(r.stars).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────
// Константы — sanity check (Калибровка A1 пересматривает их одним diff'ом)
// ─────────────────────────────────────────────────────────────────

describe('Константы', () => {
  it('STAR_THRESHOLDS монотонные и в диапазоне', () => {
    expect(STAR_THRESHOLDS.two).toBeLessThan(STAR_THRESHOLDS.three);
    expect(STAR_THRESHOLDS.three).toBeLessThan(STAR_THRESHOLDS.four);
    expect(STAR_THRESHOLDS.four).toBeLessThan(STAR_THRESHOLDS.five);
    expect(STAR_THRESHOLDS.five).toBeLessThanOrEqual(100);
  });

  it('COMPOSITE_*_WEIGHT в сумме = 1.0', () => {
    expect(COMPOSITE_MEAN_WEIGHT + COMPOSITE_MIN_WEIGHT).toBeCloseTo(1, 6);
  });

  it('WORST_CLASS_CAP: blunder ≤ верх 2★, mistake ≤ верх 3★', () => {
    expect(WORST_CLASS_CAP.blunder).toBeLessThan(STAR_THRESHOLDS.three);
    expect(WORST_CLASS_CAP.mistake).toBeLessThan(STAR_THRESHOLDS.four);
  });

  it('CLASSIFICATION_FALLBACK_ACCURACY монотонная (best ≥ good ≥ ... ≥ blunder)', () => {
    expect(CLASSIFICATION_FALLBACK_ACCURACY.best).toBeGreaterThan(
      CLASSIFICATION_FALLBACK_ACCURACY.good,
    );
    expect(CLASSIFICATION_FALLBACK_ACCURACY.good).toBeGreaterThan(
      CLASSIFICATION_FALLBACK_ACCURACY.inaccuracy,
    );
    expect(CLASSIFICATION_FALLBACK_ACCURACY.inaccuracy).toBeGreaterThan(
      CLASSIFICATION_FALLBACK_ACCURACY.mistake,
    );
    expect(CLASSIFICATION_FALLBACK_ACCURACY.mistake).toBeGreaterThan(
      CLASSIFICATION_FALLBACK_ACCURACY.blunder,
    );
  });

  it('MIN_HALF_MOVES_FOR_SCORE и MIN_DATA_FRACTION консистентны', () => {
    expect(MIN_HALF_MOVES_FOR_SCORE).toBeGreaterThanOrEqual(2);
    expect(MIN_DATA_FRACTION).toBeGreaterThan(0);
    expect(MIN_DATA_FRACTION).toBeLessThanOrEqual(1);
  });
});
