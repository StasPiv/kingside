import { describe, it, expect } from 'vitest';
import {
  deltaDFromWdl,
  deltaWFromWdl,
  wdlOrMateFallback,
  wdlSigned,
  wdlSignedFromInfo,
} from './wdl.js';

describe('wdlSigned', () => {
  it('перевес побед', () => {
    expect(wdlSigned({ w: 800, d: 200, l: 0 })).toBeCloseTo(0.8);
  });
  it('перевес поражений', () => {
    expect(wdlSigned({ w: 0, d: 200, l: 800 })).toBeCloseTo(-0.8);
  });
  it('равные шансы', () => {
    expect(wdlSigned({ w: 100, d: 800, l: 100 })).toBeCloseTo(0);
  });
});

describe('wdlSignedFromInfo', () => {
  it('берёт из wdl если есть', () => {
    expect(
      wdlSignedFromInfo({ w: 750, d: 250, l: 0 }, { type: 'cp', value: 100 }),
    ).toBeCloseTo(0.75);
  });
  it('mate без wdl → ±1', () => {
    expect(wdlSignedFromInfo(null, { type: 'mate', value: 5 })).toBe(1);
    expect(wdlSignedFromInfo(null, { type: 'mate', value: -3 })).toBe(-1);
  });
  it('cp без wdl → null', () => {
    expect(
      wdlSignedFromInfo(null, { type: 'cp', value: 100 }),
    ).toBeNull();
  });
});

describe('wdlOrMateFallback (KS-3135 / ADR-068 §2.3)', () => {
  it('возвращает wdl как есть, если он определён', () => {
    const wdl = { w: 600, d: 300, l: 100 };
    expect(wdlOrMateFallback(wdl, { type: 'cp', value: 50 })).toBe(wdl);
  });
  it('mate в пользу side-to-move → W=1000', () => {
    expect(wdlOrMateFallback(null, { type: 'mate', value: 3 })).toEqual({
      w: 1000,
      d: 0,
      l: 0,
    });
  });
  it('mate против side-to-move → L=1000', () => {
    expect(wdlOrMateFallback(undefined, { type: 'mate', value: -5 })).toEqual({
      w: 0,
      d: 0,
      l: 1000,
    });
  });
  it('cp без wdl → null (caller сам решает что делать)', () => {
    expect(wdlOrMateFallback(null, { type: 'cp', value: 250 })).toBeNull();
  });
});

describe('deltaWFromWdl (KS-3135 / ADR-068 §2.4)', () => {
  it('классический blunder: W=0.85 до → L_after=0.10 → deltaW=0.75', () => {
    const before = { w: 850, d: 100, l: 50 };
    const afterRaw = { w: 50, d: 100, l: 100 }; // POV решающего
    expect(deltaWFromWdl(before, afterRaw)).toBeCloseTo(0.75);
  });
  it('бывшие шансы испарились: W=0.95 до → L_after=0 (мат сразу)', () => {
    // mate-fallback: соперник в выигранной позиции (его L=0, W=1000),
    // блaндер L_pov_self = его W = 1000 → deltaW=(950−0)/1000=0.95.
    const before = { w: 950, d: 30, l: 20 };
    const afterRaw = { w: 1000, d: 0, l: 0 };
    expect(deltaWFromWdl(before, afterRaw)).toBeCloseTo(0.95);
  });
  it('ход чёрных, тот же знак: W=0.7 до → L_after=0.6 → deltaW=0.1', () => {
    // Знак не зависит от цвета: формула опирается на POV блaндера,
    // а Stockfish уже отдаёт POV side-to-move.
    const before = { w: 700, d: 200, l: 100 };
    const afterRaw = { w: 100, d: 300, l: 600 };
    expect(deltaWFromWdl(before, afterRaw)).toBeCloseTo(0.1);
  });
  it('нет блaндера: W_до=0.5, L_after=0.5 → deltaW=0', () => {
    const before = { w: 500, d: 0, l: 500 };
    const afterRaw = { w: 0, d: 0, l: 500 };
    expect(deltaWFromWdl(before, afterRaw)).toBeCloseTo(0);
  });
  it('отрицательная дельта (ход улучшил позицию): W_до=0.3, L_after=0.8 → −0.5', () => {
    const before = { w: 300, d: 400, l: 300 };
    const afterRaw = { w: 100, d: 100, l: 800 };
    expect(deltaWFromWdl(before, afterRaw)).toBeCloseTo(-0.5);
  });
});

describe('deltaDFromWdl (KS-3135 / ADR-068 §2.4)', () => {
  it('зевок ничьи: D_до=0.7 → D_after=0.05 → deltaD=0.65', () => {
    const before = { w: 50, d: 700, l: 250 };
    const afterRaw = { w: 900, d: 50, l: 50 };
    expect(deltaDFromWdl(before, afterRaw)).toBeCloseTo(0.65);
  });
  it('D симметрично при смене стороны: 0.5 vs 0.5 → 0', () => {
    const before = { w: 250, d: 500, l: 250 };
    const afterRaw = { w: 250, d: 500, l: 250 };
    expect(deltaDFromWdl(before, afterRaw)).toBeCloseTo(0);
  });
  it('mate-fallback после хода: D_after=0 → deltaD=D_до', () => {
    const before = { w: 100, d: 600, l: 300 };
    const afterRaw = { w: 1000, d: 0, l: 0 };
    expect(deltaDFromWdl(before, afterRaw)).toBeCloseTo(0.6);
  });
  it('отрицательная deltaD: D вырос на ходе → −0.4', () => {
    const before = { w: 500, d: 200, l: 300 };
    const afterRaw = { w: 200, d: 600, l: 200 };
    expect(deltaDFromWdl(before, afterRaw)).toBeCloseTo(-0.4);
  });
});
