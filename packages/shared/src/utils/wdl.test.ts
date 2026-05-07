import { describe, it, expect } from 'vitest';
import { wdlSigned, wdlSignedFromInfo } from './wdl.js';

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
