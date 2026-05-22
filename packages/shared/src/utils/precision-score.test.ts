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
 *
 * KS-3030: classification по умолчанию НЕ задаётся, чтобы избежать
 * срабатывания best-override на loss-сценариях. Если нужно явно
 * указать класс — передать вторым аргументом.
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
    ...(klass ? { classification: klass } : {}),
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

  it('KS-3030: classification=best → 100 (best-override), не 95 fallback', () => {
    expect(
      accuracyMove({ wdlBefore: null, classification: 'best' }),
    ).toBe(100);
  });

  describe('KS-3030: best-override (NAG ! ⟺ accuracy=100)', () => {
    it('isBestMove=true перебивает WDL-loss (репро 824f6b26)', () => {
      // Сценарий из KS-3030: ход совпал с PV1, но WDL шумел между
      // depths SF — например, eBefore=0.83, eAfter=0.81 (loss_E=0.02
      // дало бы accuracy ≈ 91.4). С override — 100.
      const a = accuracyMove({
        wdlBefore: { w: 800, d: 60, l: 140 },
        wdlAfter: { w: 780, d: 60, l: 160 },
        isBestMove: true,
      });
      expect(a).toBe(100);
    });

    it('playedUci === bestUci → accuracy=100, без WDL расчёта', () => {
      const a = accuracyMove({
        wdlBefore: { w: 800, d: 60, l: 140 },
        wdlAfter: { w: 780, d: 60, l: 160 },
        playedUci: 'e2e4',
        bestUci: 'e2e4',
      });
      expect(a).toBe(100);
    });

    it('playedUci !== bestUci и нет isBestMove → обычный WDL-расчёт', () => {
      const a = accuracyMove({
        wdlBefore: { w: 800, d: 60, l: 140 },
        wdlAfter: { w: 780, d: 60, l: 160 },
        playedUci: 'e2e4',
        bestUci: 'd2d4',
      });
      // loss_E = max(0, 0.83 - 0.81) = 0.02 → accuracy ≈ 91.4.
      expect(a).toBeLessThan(95);
      expect(a).toBeGreaterThan(85);
    });

    it('classification=best с WDL-loss → 100 (override классификации)', () => {
      // Эквивалент UX-сценария 824f6b26: ход помечен best, WDL слегка
      // дёрнулся — accuracy всё равно 100.
      const a = accuracyMove({
        wdlBefore: { w: 800, d: 60, l: 140 },
        wdlAfter: { w: 780, d: 60, l: 160 },
        classification: 'best',
      });
      expect(a).toBe(100);
    });

    it('computePrecisionScore: 3 best с WDL-jitter → score=5, scorePct=100 (репро 824f6b26)', () => {
      const moves: PrecisionMoveInput[] = [
        {
          wdlBefore: { w: 800, d: 60, l: 140 },
          wdlAfter: { w: 820, d: 60, l: 120 }, // +2 п.п. — улучшение
          isBestMove: true,
        },
        {
          wdlBefore: { w: 820, d: 60, l: 120 },
          wdlAfter: { w: 810, d: 70, l: 120 }, // мелкий jitter
          isBestMove: true,
        },
        {
          wdlBefore: { w: 810, d: 70, l: 120 },
          wdlAfter: { w: 850, d: 50, l: 100 }, // +4 п.п.
          isBestMove: true,
        },
      ];
      const r = computePrecisionScore(moves);
      expect(r.stars).toBe(5);
      expect(r.scorePct).toBe(100);
    });
  });

  it('classification fallback: good → 80, blunder → 5 (override НЕ для не-best)', () => {
    expect(
      accuracyMove({ wdlBefore: null, classification: 'good' }),
    ).toBe(80);
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
    // KS-3030: best → 100 (override), не 95 fallback.
    // accuracies = [100, 100, 80, 55]; mean=83.75; min=55;
    // composite = 0.7*83.75 + 0.3*55 = 58.625 + 16.5 = 75.125.
    // worst=inaccuracy → no cap. mapToStars(75.125) = 3.
    const r = computePrecisionScore(moves);
    expect(r.stars).toBe(3);
    expect(r.scorePct).toBeCloseTo(75.125, 2);
  });
});

describe('computePrecisionScore — edge cases (ADR §3.4)', () => {
  it('length=0 → null', () => {
    const r = computePrecisionScore([]);
    expect(r.stars).toBeNull();
    expect(r.scorePct).toBeNull();
  });

  // KS-3033: раньше length=1 → null (MIN_HALF_MOVES_FOR_SCORE=2),
  // теперь считается полноценно (см. describe «KS-3033: 1-move attempt»).
  it('KS-3033: length=1 с best-ходом → score=5 (не null)', () => {
    const r = computePrecisionScore([perfectWdl()]);
    expect(r.stars).toBe(5);
    expect(r.scorePct).toBe(100);
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
    // KS-3033: понижено до 1 (раньше 2).
    expect(MIN_HALF_MOVES_FOR_SCORE).toBeGreaterThanOrEqual(1);
    expect(MIN_DATA_FRACTION).toBeGreaterThan(0);
    expect(MIN_DATA_FRACTION).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// KS-3033: 1-move attempts должны давать звезду (была регрессия —
// показывался «Балл недоступен» вместо звезды).
// ─────────────────────────────────────────────────────────────────

describe('KS-3033: computePrecisionScore на 1-ходовом attempt', () => {
  it('1 best-ход (WDL 100/0/0 → 100/0/0) → score=5, scorePct=100', () => {
    const r = computePrecisionScore([
      {
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 1000, d: 0, l: 0 },
        isBestMove: true,
      },
    ]);
    expect(r.stars).toBe(5);
    expect(r.scorePct).toBe(100);
  });

  it('1 blunder (Nxc6?? — WDL 100/0/0 → 0/0/100, loss_E=1.0) → score=1', () => {
    // Точное воспроизведение KS-3033 attempt #2c6ed2b7.
    const r = computePrecisionScore([
      {
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 0, d: 0, l: 1000 },
        classification: 'blunder',
      },
    ]);
    expect(r.stars).toBe(1);
    // accuracy_move(loss=100) ≈ 0; mean=min=0; composite=0.
    // worst-class cap=60 не активируется (0 < 60). Итог < 50 → 1★.
    expect(r.scorePct).toBeLessThan(50);
  });

  it('1 mistake (loss_E=0.20) → score=1 (composite=40, cap=80 не активен)', () => {
    // На 1-ходовом attempt mean=min=accuracy этого хода.
    // accuracy_move(loss=20) ≈ 40 → composite 40, cap mistake=80 (не
    // активен 40<80). 40 < 50 → 1★.
    const r = computePrecisionScore([
      {
        wdlBefore: { w: 600, d: 300, l: 100 }, // E=0.75
        wdlAfter: { w: 400, d: 300, l: 300 }, // E=0.55, loss_E=0.20
        classification: 'mistake',
      },
    ]);
    expect(r.stars).toBe(1);
    expect(r.scorePct).toBeGreaterThan(35);
    expect(r.scorePct).toBeLessThan(45);
  });

  it('1 inaccuracy (loss_E=0.08) → score=2 (composite≈69.7, ниже границы 70)', () => {
    // accuracy_move(loss=8) ≈ 69.66 → composite=69.66 → 2★ (< 70).
    // На границе 70 (3★/2★) — попадает в 2★. Cap inaccuracy нет.
    const r = computePrecisionScore([
      {
        wdlBefore: { w: 600, d: 300, l: 100 }, // E=0.75
        wdlAfter: { w: 520, d: 300, l: 180 }, // E=0.67, loss_E=0.08
        classification: 'inaccuracy',
      },
    ]);
    expect(r.stars).toBe(2);
    expect(r.scorePct).toBeGreaterThan(65);
    expect(r.scorePct).toBeLessThan(70);
  });

  it('1 good-ход (loss_E=0.03) → score=4 (composite~87)', () => {
    // accuracy_move(loss=3) ≈ 87 → 4★.
    const r = computePrecisionScore([
      {
        wdlBefore: { w: 600, d: 300, l: 100 }, // E=0.75
        wdlAfter: { w: 570, d: 300, l: 130 }, // E=0.72, loss_E=0.03
        classification: 'good',
      },
    ]);
    expect(r.stars).toBe(4);
  });

  it('1 ход без данных (wdl=cp=classification=null) → null (>50% gaps)', () => {
    // 1 из 1 без данных = 100% gaps, > 50% → null.
    const r = computePrecisionScore([
      { wdlBefore: null, wdlAfter: null, cpBefore: null, cpAfter: null },
    ]);
    expect(r.stars).toBeNull();
    expect(r.scorePct).toBeNull();
  });

  it('length=0 (нет ходов) → null (после KS-3033 default min=1)', () => {
    // Защита: даже после понижения MIN_HALF_MOVES_FOR_SCORE до 1
    // пустой массив остаётся null.
    const r = computePrecisionScore([]);
    expect(r.stars).toBeNull();
    expect(r.scorePct).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// KS-3246: evaluateObjectiveAchieved / computeAttemptObjectiveAchieved /
// computeVerdictKey
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
      expect(evaluateObjectiveAchieved(0.75, 0.87, 'convertAdvantage')).toBe(
        true,
      );
    });
    it('end_E = start_E → true', () => {
      expect(evaluateObjectiveAchieved(0.8, 0.8, 'convertAdvantage')).toBe(
        true,
      );
    });
    it('end_E = start_E − 0.02 (граница) → true', () => {
      expect(
        evaluateObjectiveAchieved(0.8, 0.78, 'convertAdvantage'),
      ).toBe(true);
    });
    it('end_E = start_E − 0.03 → false', () => {
      expect(
        evaluateObjectiveAchieved(0.8, 0.77, 'convertAdvantage'),
      ).toBe(false);
    });
  });

  describe('saveEquality (tolerance=0.05)', () => {
    it('end_E = start_E − 0.05 (граница) → true', () => {
      expect(evaluateObjectiveAchieved(0.5, 0.45, 'saveEquality')).toBe(true);
    });
    it('end_E = start_E − 0.06 → false', () => {
      expect(evaluateObjectiveAchieved(0.5, 0.44, 'saveEquality')).toBe(false);
    });
    it('KS-3247 кейс: 59% → 46% draw, +14% loss → end_E ≈ 0.23 vs start ≈ 0.295 → false', () => {
      // W=0, D=590, L=410 → E = (0 + 295) / 1000 = 0.295
      // W=0, D=460, L=540 → E = 0.23
      // ΔE = −0.065 — больше tolerance 0.05 → goal NOT achieved.
      expect(evaluateObjectiveAchieved(0.295, 0.23, 'saveEquality')).toBe(
        false,
      );
    });
  });

  it('null/undefined аргумент → null', () => {
    expect(evaluateObjectiveAchieved(null, 0.5, 'convertAdvantage')).toBeNull();
    expect(evaluateObjectiveAchieved(0.5, null, 'saveEquality')).toBeNull();
    expect(
      evaluateObjectiveAchieved(undefined, undefined, 'convertAdvantage'),
    ).toBeNull();
  });

  it('NaN → null (защита от мусорных данных)', () => {
    expect(
      evaluateObjectiveAchieved(NaN, 0.5, 'convertAdvantage'),
    ).toBeNull();
    expect(evaluateObjectiveAchieved(0.5, NaN, 'saveEquality')).toBeNull();
  });

  it('OBJECTIVE_TOLERANCE экспортирован и содержит обе цели', () => {
    expect(OBJECTIVE_TOLERANCE.convertAdvantage).toBe(0.02);
    expect(OBJECTIVE_TOLERANCE.saveEquality).toBe(0.05);
  });
});

describe('KS-3246 computeAttemptObjectiveAchieved', () => {
  it('KS-3246 кейс: convertAdvantage, ΔE = +0.12 (Win 75 → 87) → true', () => {
    // start: W=750, D=250, L=0 → E = 0.875
    // end:   W=870, D=130, L=0 → E = 0.935
    // ΔE = +0.06 → true (для convertAdvantage tolerance 0.02)
    const moves: PrecisionMoveInput[] = [
      {
        wdlBefore: { w: 750, d: 250, l: 0 },
        wdlAfter: { w: 870, d: 130, l: 0 },
        classification: 'inaccuracy',
      },
    ];
    expect(computeAttemptObjectiveAchieved(moves, 'convertAdvantage')).toBe(
      true,
    );
  });

  it('KS-3247 кейс: saveEquality, single move, end_E < start_E − tolerance → false', () => {
    const moves: PrecisionMoveInput[] = [
      {
        wdlBefore: { w: 0, d: 590, l: 410 },
        wdlAfter: { w: 0, d: 460, l: 540 },
        classification: 'inaccuracy',
      },
    ];
    expect(computeAttemptObjectiveAchieved(moves, 'saveEquality')).toBe(false);
  });

  it('берёт первый move с wdlBefore и последний с wdlAfter', () => {
    const moves: PrecisionMoveInput[] = [
      {
        wdlBefore: { w: 750, d: 250, l: 0 },
        wdlAfter: null,
        classification: 'best',
      },
      {
        wdlBefore: { w: 800, d: 200, l: 0 },
        wdlAfter: { w: 900, d: 100, l: 0 },
        classification: 'best',
      },
    ];
    // start_E = (750+125)/1000 = 0.875 (из первого move's wdlBefore)
    // end_E = (900+50)/1000 = 0.95 (из последнего move's wdlAfter)
    // ΔE = +0.075 → true
    expect(computeAttemptObjectiveAchieved(moves, 'convertAdvantage')).toBe(
      true,
    );
  });

  it('null если нет ни одного wdlBefore', () => {
    const moves: PrecisionMoveInput[] = [
      { classification: 'inaccuracy', cpBefore: 100, cpAfter: 80 },
    ];
    expect(
      computeAttemptObjectiveAchieved(moves, 'convertAdvantage'),
    ).toBeNull();
  });

  it('пустой массив → null', () => {
    expect(computeAttemptObjectiveAchieved([], 'saveEquality')).toBeNull();
  });
});

describe('KS-3246 / KS-3248 computeVerdictKey', () => {
  it('null stars → null verdict', () => {
    expect(computeVerdictKey(null, true)).toBeNull();
    expect(computeVerdictKey(null, false)).toBeNull();
    expect(computeVerdictKey(null, null)).toBeNull();
  });

  describe('GOAL_ACHIEVED = true', () => {
    it('5★ → flawless', () => {
      expect(computeVerdictKey(5, true)).toBe('flawless');
    });
    it('4★ → confident', () => {
      expect(computeVerdictKey(4, true)).toBe('confident');
    });
    it('3★ → suboptimal', () => {
      expect(computeVerdictKey(3, true)).toBe('suboptimal');
    });
    it('2★ → with-mistakes', () => {
      expect(computeVerdictKey(2, true)).toBe('with-mistakes');
    });
    it('1★ → with-blunders', () => {
      expect(computeVerdictKey(1, true)).toBe('with-blunders');
    });
  });

  describe('GOAL_ACHIEVED = false', () => {
    it('5★ → flawless (защитный fallback, не должен возникать)', () => {
      expect(computeVerdictKey(5, false)).toBe('flawless');
    });
    it('4★ → goal-missed-clean', () => {
      expect(computeVerdictKey(4, false)).toBe('goal-missed-clean');
    });
    it('3★ → goal-missed', () => {
      expect(computeVerdictKey(3, false)).toBe('goal-missed');
    });
    it('2★ → goal-missed-mistakes', () => {
      expect(computeVerdictKey(2, false)).toBe('goal-missed-mistakes');
    });
    it('1★ → goal-missed-blunders', () => {
      expect(computeVerdictKey(1, false)).toBe('goal-missed-blunders');
    });
  });

  it('GOAL_ACHIEVED = null → ведём как true (legacy fallback)', () => {
    expect(computeVerdictKey(5, null)).toBe('flawless');
    expect(computeVerdictKey(4, null)).toBe('confident');
    expect(computeVerdictKey(3, null)).toBe('suboptimal');
    expect(computeVerdictKey(2, null)).toBe('with-mistakes');
    expect(computeVerdictKey(1, null)).toBe('with-blunders');
  });

  it('KS-3246 матрица соответствует chess-expert review (5×2)', () => {
    // Сценарий из задачи: 3★ + goal_achieved=true →
    // «не лучшим путём», НЕ «с заметными ошибками»
    expect(computeVerdictKey(3, true)).toBe('suboptimal');
    // Старая плашка ассоциировалась с этим verdictKey'ом ='with-mistakes'
    // — это теперь 2★ + goal_achieved=true. Если фронт получит
    // 3★ + true и нарисует «с заметными ошибками» — это баг фронта.
    expect(computeVerdictKey(2, true)).toBe('with-mistakes');
  });
});
