import { describe, expect, it } from 'vitest';
import {
  evaluateBlunder,
  type BlunderEvalSettings,
} from './puzzle-gen-core.js';

const DEFAULT_SETTINGS: BlunderEvalSettings = {
  deltaWThreshold: 0.6,
  deltaDThreshold: 0.6,
  minWAfterForSolver: 0.5,
  minWPlusDAfterForSolver: 0.5,
};

describe('evaluateBlunder (KS-3136 / ADR-068)', () => {
  it('классический blunder: W упал с 0.85 до 0.10 (solver выиграл) — accept, trigger=W', () => {
    // before POV блaндера: W=0.85 D=0.10 L=0.05.
    // after POV решающего (после хода блaндера): W=0.85 D=0.10 L=0.05
    // → L_after_raw=0.05 → deltaW = (0.85 − 0.05)/1 = 0.80.
    // W_after_for_solver = 0.85 ≥ 0.5 ✓.
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
    // before POV блaндера: W=0.10 D=0.70 L=0.20.
    // after POV решающего: W=0.85 D=0.05 L=0.10
    // → deltaW = (0.10 − 0.10)/1 = 0 (порог W не пробит).
    // → deltaD = (0.70 − 0.05)/1 = 0.65 (≥0.6 ✓).
    // W+D after_for_solver = 0.85 + 0.05 = 0.90 ≥ 0.5 ✓.
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

  it('оба триггера сработали: trigger=WD (синтетические низкие пороги)', () => {
    // Физическое замечание: при дефолтных порогах 0.6/0.6 кейс
    // `trigger='WD'` нереалистичен — потребовал бы W_до ≥ 0.6 И
    // D_до ≥ 0.6 одновременно, что нарушает инвариант W+D+L=1
    // (W+D ≤ 1). Для покрытия ветки берём ослабленные пороги 0.2/0.2.
    //
    // before W=0.60 D=0.40 L=0.00.
    // after POV решающего: W=0.70 D=0.00 L=0.30.
    // → deltaW = (0.60 − 0.30) = 0.30 ≥ 0.2 ✓.
    // → deltaD = (0.40 − 0.00) = 0.40 ≥ 0.2 ✓.
    // W_after_for_solver = 0.70 ≥ 0.2 (settings.minW) ✓.
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 600, d: 400, l: 0 },
        wdlAfterRaw: { w: 700, d: 0, l: 300 },
      },
      {
        deltaWThreshold: 0.2,
        deltaDThreshold: 0.2,
        minWAfterForSolver: 0.2,
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
    // before W=0.55 D=0.40 L=0.05; after W=0.55 D=0.40 L=0.05
    // → deltaW = 0.55 − 0.05 = 0.50 (< 0.6); deltaD = 0 < 0.6.
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

  it('triggerByW, но W_after_for_solver < 0.5 → lowWAfterForSolver', () => {
    // before W=0.70 D=0.20 L=0.10.
    // after POV решающего: W=0.30 D=0.65 L=0.05
    // → deltaW = (0.70 − 0.05) = 0.65 ✓.
    // W_after_for_solver = 0.30 < 0.5 — пазл «победил мираж» → reject.
    const result = evaluateBlunder(
      {
        wdlBeforeRaw: { w: 700, d: 200, l: 100 },
        wdlAfterRaw: { w: 300, d: 650, l: 50 },
      },
      DEFAULT_SETTINGS,
    );
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('lowWAfterForSolver');
      expect(result.deltaW).toBeCloseTo(0.65);
    }
  });

  it('triggerByD без W, но W+D after < 0.5 → lowWplusDAfter', () => {
    // before W=0.05 D=0.70 L=0.25; after POV решающего: W=0.20 D=0.05 L=0.75.
    // → deltaW = (0.05 − 0.75) = −0.70 (отрицательная, ниже порога).
    // → deltaD = (0.70 − 0.05) = 0.65 ≥ 0.6 ✓.
    // W+D after = 0.20 + 0.05 = 0.25 < 0.5 — решающий в проигрыше → reject.
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

  it('POV-инверсия для хода чёрных: формула не зависит от цвета', () => {
    // Stockfish отдаёт POV side-to-move. Если на fenBefore ход чёрных
    // (= блaндер чёрные), wdlBeforeRaw уже POV блaндера (чёрных).
    // wdlAfterRaw — POV side-to-move на fenAfter (= белые = solver).
    // Формула одна и та же.
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
    // before W=0.20; after POV решающего W=0.10 D=0.10 L=0.80 → deltaW
    // = (0.20 − 0.80) = −0.60. Дельта отрицательная — порог не пробит.
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
    // before W=0.90 D=0.05 L=0.05; after = {w:1000,d:0,l:0}
    // (mate-fallback в пользу solver) → L_after_raw = 0 → deltaW =
    // 0.90 ✓. W_after_for_solver = 1.0 ≥ 0.5 ✓.
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
        deltaWThreshold: 0.3, // ослаблено
        deltaDThreshold: 0.3,
        minWAfterForSolver: 0.5,
        minWPlusDAfterForSolver: 0.5,
      },
    );
    expect(result.kind).toBe('blunder');
    if (result.kind === 'blunder') {
      expect(result.deltaW).toBeCloseTo(0.4); // 0.50 − 0.10
    }
  });
});
