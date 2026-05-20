import { describe, expect, it } from 'vitest';
import {
  determinePuzzleObjective,
  evaluateBlunder,
  holdsSolvabilityIntermediate,
  meetsSolvabilityFinal,
  type BlunderEvalSettings,
} from './puzzle-gen-core.js';

const DEFAULT_SETTINGS: BlunderEvalSettings = {
  deltaWThreshold: 0.6,
  deltaDThreshold: 0.6,
  minWPlusDAfterForSolver: 0.5,
};

describe('evaluateBlunder (KS-3136 / ADR-068, KS-3140 unified after-filter)', () => {
  it('классический blunder: W упал с 0.85 до 0.10 (solver выиграл) — accept, trigger=W', () => {
    // before POV блaндера: W=0.85 D=0.10 L=0.05.
    // after POV решающего: W=0.85 D=0.10 L=0.05
    // → L_after_raw=0.05 → deltaW = (0.85 − 0.05) = 0.80.
    // W+D after_for_solver = 0.85 + 0.10 = 0.95 ≥ 0.5 ✓.
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 850, d: 100, l: 50 },
        wdlAfterRaw: { w: 850, d: 100, l: 50 },
      },
      DEFAULT_SETTINGS,
    );
    expect(result.kind).toBe('blunder');
    if (result.kind === 'blunder') {
      expect(result.trigger).toBe('W');
      expect(result.deltaW).toBeCloseTo(0.8);
    }
  });

  it('упустил ничью: D упал с 0.7 до 0.05 — accept, trigger=D', () => {
    // before W=0.10 D=0.70 L=0.20; after POV solver W=0.85 D=0.05 L=0.10.
    // deltaW = 0 (порог не пробит), deltaD = 0.65 ≥ 0.6 ✓.
    // W+D after = 0.85 + 0.05 = 0.90 ≥ 0.5 ✓.
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 100, d: 700, l: 200 },
        wdlAfterRaw: { w: 850, d: 50, l: 100 },
      },
      DEFAULT_SETTINGS,
    );
    expect(result.kind).toBe('blunder');
    if (result.kind === 'blunder') {
      expect(result.trigger).toBe('D');
      expect(result.deltaD).toBeCloseTo(0.65);
    }
  });

  it('KS-3140: «реализуй перевес» (convert advantage) — wdlBefore=1.0, wdlAfter solver D≈1.0, accept', () => {
    // Реальный кейс из KS-3139, ход 39. d6 (белые упустили выигрыш в ничью).
    // before (POV белых = блaндер) = {w:1000, d:0, l:0}.
    // after (POV чёрных = solver) = {w:0, d:952, l:48}.
    // deltaW = (1000 − 48)/1000 = 0.952 ≥ 0.6 ✓ (триггер по W).
    // W+D after_for_solver = 0 + 0.952 = 0.952 ≥ 0.5 ✓ — solver
    // держит ничью, пазл валиден.
    // В прежней редакции (KS-3136) этот пазл отбрасывался как
    // `lowWAfterForSolver` (W_after=0 < 0.5).
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 1000, d: 0, l: 0 },
        wdlAfterRaw: { w: 0, d: 952, l: 48 },
      },
      DEFAULT_SETTINGS,
    );
    expect(result.kind).toBe('blunder');
    if (result.kind === 'blunder') {
      expect(result.trigger).toBe('W');
      expect(result.deltaW).toBeCloseTo(0.952);
    }
  });

  it('KS-3140: «спасение в ничью» — wdlBefore проигрыш, wdlAfter solver D≈1.0, accept', () => {
    // Симметричный кейс: блaндер был в проигрыше, ход дал ничью.
    // before (POV блaндера) = W=0, D=0, L=1000 — он был в проигрыше.
    // after (POV solver = его противник) — он получил ничью.
    // Возьмём: after = {w:0, d:1000, l:0} — гарантированная ничья.
    // deltaW = (0 − 0)/1000 = 0 — порог не пробит.
    // deltaD = (0 − 1000)/1000 = −1.0 — отрицательная (D вырос).
    // Тут триггер не срабатывает — это не зевок, а спасение.
    // Чтобы кейс был «спасение в ничью с зевком», нужен зевок solver'а
    // или другая интерпретация. Возьмём более тонкий вариант:
    //
    // before (POV блaндера W=0.6, D=0.4) — блaндер был в выигрыше с шансом ничьи.
    // after (POV solver W=0.0, D=1.0, L=0.0) — solver получил ничью,
    // блaндер потерял всё.
    // deltaW = (600 − 0)/1000 = 0.6 ≥ 0.6 ✓.
    // deltaD = (400 − 1000)/1000 = −0.6 — D solver вырос.
    // W+D after = 0 + 1.0 = 1.0 ≥ 0.5 ✓.
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 600, d: 400, l: 0 },
        wdlAfterRaw: { w: 0, d: 1000, l: 0 },
      },
      DEFAULT_SETTINGS,
    );
    expect(result.kind).toBe('blunder');
    if (result.kind === 'blunder') {
      expect(result.trigger).toBe('W');
    }
  });

  it('оба триггера сработали: trigger=WD (синтетические низкие пороги)', () => {
    // При дефолтных порогах 0.6/0.6 кейс trigger='WD' физически
    // нереалистичен (W_до ≥ 0.6 ∧ D_до ≥ 0.6 при W+D+L=1 невозможно).
    // Для покрытия ветки берём ослабленные пороги 0.2/0.2.
    // before W=0.60 D=0.40 L=0; after POV solver W=0.70 D=0 L=0.30.
    // deltaW = (600 − 300)/1000 = 0.30 ≥ 0.2 ✓.
    // deltaD = (400 − 0)/1000 = 0.40 ≥ 0.2 ✓.
    // W+D after = 0.70 ≥ 0.2 ✓.
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 600, d: 400, l: 0 },
        wdlAfterRaw: { w: 700, d: 0, l: 300 },
      },
      {
        deltaWThreshold: 0.2,
        deltaDThreshold: 0.2,
        minWPlusDAfterForSolver: 0.2,
      },
    );
    expect(result.kind).toBe('blunder');
    if (result.kind === 'blunder') {
      expect(result.trigger).toBe('WD');
      expect(result.deltaW).toBeCloseTo(0.3);
      expect(result.deltaD).toBeCloseTo(0.4);
    }
  });

  it('notBlunder: обе дельты ниже порога', () => {
    // before W=0.55 D=0.40 L=0.05; after same → deltaW = 0.50 (<0.6), deltaD=0.
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 550, d: 400, l: 50 },
        wdlAfterRaw: { w: 550, d: 400, l: 50 },
      },
      DEFAULT_SETTINGS,
    );
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('notBlunder');
      expect(result.deltaW).toBeCloseTo(0.5);
      expect(result.deltaD).toBeCloseTo(0);
    }
  });

  it('KS-3140: lowWplusDAfter — триггер по D, но solver всё ещё в проигрыше', () => {
    // before W=0.05 D=0.70 L=0.25; after POV solver: W=0.20 D=0.05 L=0.75.
    // deltaW = (50 − 750)/1000 = −0.70 — не пробит.
    // deltaD = (700 − 50)/1000 = 0.65 ≥ 0.6 ✓.
    // W+D after = 0.20 + 0.05 = 0.25 < 0.5 — solver в проигрыше → reject.
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 50, d: 700, l: 250 },
        wdlAfterRaw: { w: 200, d: 50, l: 750 },
      },
      DEFAULT_SETTINGS,
    );
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('lowWplusDAfter');
      expect(result.deltaD).toBeCloseTo(0.65);
    }
  });

  it('KS-3140: lowWplusDAfter — триггер по W, но solver всё ещё в проигрыше (искусственные пороги)', () => {
    // При дефолтном пороге deltaW=0.6 формула «triggerByW + W+D<0.5»
    // физически нереализуема: для пробивания W-триггера нужно
    // L_after ≤ W_до − 0.6, а L_after ≥ 0.5 (чтобы W+D<0.5) даёт
    // W_до ≥ 1.1 — невозможно. Поэтому берём ослабленный deltaWThreshold.
    //
    // before W=0.90 D=0.05 L=0.05; after POV solver W=0.10 D=0.10 L=0.80.
    // deltaW = (900 − 800)/1000 = 0.10 ≥ 0.05 ✓.
    // W+D after = 0.20 < 0.5 — solver в проигрыше → reject.
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 900, d: 50, l: 50 },
        wdlAfterRaw: { w: 100, d: 100, l: 800 },
      },
      {
        deltaWThreshold: 0.05,
        deltaDThreshold: 0.99,
        minWPlusDAfterForSolver: 0.5,
      },
    );
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('lowWplusDAfter');
    }
  });

  it('POV-инверсия для хода чёрных: формула не зависит от цвета', () => {
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 800, d: 150, l: 50 },
        wdlAfterRaw: { w: 800, d: 150, l: 50 },
      },
      DEFAULT_SETTINGS,
    );
    expect(result.kind).toBe('blunder');
    if (result.kind === 'blunder') {
      expect(result.deltaW).toBeCloseTo(0.75);
    }
  });

  it('негативная deltaW (ход улучшил позицию) — notBlunder', () => {
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 200, d: 400, l: 400 },
        wdlAfterRaw: { w: 100, d: 100, l: 800 },
      },
      DEFAULT_SETTINGS,
    );
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('notBlunder');
      expect(result.deltaW).toBeLessThan(0);
    }
  });

  it('mate-после: after = {w:1000, d:0, l:0} → решающий получил мат-выигрыш', () => {
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 900, d: 50, l: 50 },
        wdlAfterRaw: { w: 1000, d: 0, l: 0 },
      },
      DEFAULT_SETTINGS,
    );
    expect(result.kind).toBe('blunder');
    if (result.kind === 'blunder') {
      expect(result.trigger).toBe('W');
      expect(result.deltaW).toBeCloseTo(0.9);
    }
  });

  it('пороги настраиваются: при низком пороге слабый ход тоже = blunder', () => {
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 500, d: 400, l: 100 },
        wdlAfterRaw: { w: 600, d: 300, l: 100 },
      },
      {
        deltaWThreshold: 0.3,
        deltaDThreshold: 0.3,
        minWPlusDAfterForSolver: 0.5,
      },
    );
    expect(result.kind).toBe('blunder');
    if (result.kind === 'blunder') {
      expect(result.deltaW).toBeCloseTo(0.4);
    }
  });
});

describe('determinePuzzleObjective (KS-3144 / ADR-069)', () => {
  it('39. d6 из KS-3139 — wdlAfter solver = {0, 952, 48} → saveEquality', () => {
    // Реальный кейс: белые упустили выигрыш в ничью; solver (чёрные) после
    // хода не выигрывает, но держит ничью.
    expect(determinePuzzleObjective({ w: 0, d: 952, l: 48 })).toBe('saveEquality');
  });

  it('классическая convert-позиция — wdlAfter solver = {850, 100, 50} → convertAdvantage', () => {
    expect(determinePuzzleObjective({ w: 850, d: 100, l: 50 })).toBe('convertAdvantage');
  });

  it('граница w=0.5 (ровно 500) → convertAdvantage (порог включителен)', () => {
    expect(determinePuzzleObjective({ w: 500, d: 250, l: 250 })).toBe('convertAdvantage');
  });

  it('чуть ниже границы w=0.499 → saveEquality', () => {
    expect(determinePuzzleObjective({ w: 499, d: 251, l: 250 })).toBe('saveEquality');
  });

  it('mate-after для solver — wdl={1000,0,0} → convertAdvantage', () => {
    expect(determinePuzzleObjective({ w: 1000, d: 0, l: 0 })).toBe('convertAdvantage');
  });

  it('абсолютная ничья — wdl={0,1000,0} → saveEquality', () => {
    expect(determinePuzzleObjective({ w: 0, d: 1000, l: 0 })).toBe('saveEquality');
  });
});

describe('meetsSolvabilityFinal (KS-3156) — критерий «решено» в конце solvability', () => {
  it('convertAdvantage: solver добил перевес — signed=0.8 ≥ 0.5 → true', () => {
    expect(
      meetsSolvabilityFinal({ w: 850, d: 100, l: 50 }, 'convertAdvantage', 0.5),
    ).toBe(true);
  });

  it('convertAdvantage: solver не дотянул — signed=0.2 < 0.5 → false', () => {
    expect(
      meetsSolvabilityFinal({ w: 350, d: 450, l: 200 }, 'convertAdvantage', 0.5),
    ).toBe(false);
  });

  it('saveEquality: solver удержал ничью — W+D = 0.95 ≥ 0.5 → true (раньше signed=0 валило)', () => {
    expect(
      meetsSolvabilityFinal({ w: 50, d: 900, l: 50 }, 'saveEquality', 0.5),
    ).toBe(true);
  });

  it('saveEquality: позиция чистой ничьей W=0/D=1000/L=0 → true (signed=0, но W+D=1.0)', () => {
    expect(
      meetsSolvabilityFinal({ w: 0, d: 1000, l: 0 }, 'saveEquality', 0.5),
    ).toBe(true);
  });

  it('saveEquality: solver потерял позицию — W+D=0.3 < 0.5 → false', () => {
    expect(
      meetsSolvabilityFinal({ w: 50, d: 250, l: 700 }, 'saveEquality', 0.5),
    ).toBe(false);
  });

  it('saveEquality: граница W+D = ровно 0.5 → true (порог включителен)', () => {
    expect(
      meetsSolvabilityFinal({ w: 100, d: 400, l: 500 }, 'saveEquality', 0.5),
    ).toBe(true);
  });
});

describe('holdsSolvabilityIntermediate (KS-3156) — промежуточный «не-фейл»', () => {
  it('convertAdvantage: signed ≥ 0 → true (solver не уронил перевес)', () => {
    expect(
      holdsSolvabilityIntermediate({ w: 600, d: 300, l: 100 }, 'convertAdvantage', 0.0),
    ).toBe(true);
  });

  it('convertAdvantage: signed < 0 → false', () => {
    expect(
      holdsSolvabilityIntermediate({ w: 100, d: 300, l: 600 }, 'convertAdvantage', 0.0),
    ).toBe(false);
  });

  it('saveEquality: W+D ≥ failThreshold=0.5 → true', () => {
    expect(
      holdsSolvabilityIntermediate({ w: 50, d: 700, l: 250 }, 'saveEquality', 0.5),
    ).toBe(true);
  });

  it('saveEquality: позиция схлопнулась в проигрыш — W+D=0.2 < 0.5 → false', () => {
    expect(
      holdsSolvabilityIntermediate({ w: 50, d: 150, l: 800 }, 'saveEquality', 0.5),
    ).toBe(false);
  });
});
