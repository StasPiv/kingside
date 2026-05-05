import {
  cpFromSide,
  isMateScore,
  isMateForSideToMove,
  wdlSigned,
  wdlSignedFromInfo,
  wdlFromSide,
} from './score';

describe('cpFromSide', () => {
  it('cp same side: identity', () => {
    expect(cpFromSide({ type: 'cp', value: 300 }, 'w', 'w')).toBe(300);
  });
  it('cp opposite side: invert', () => {
    expect(cpFromSide({ type: 'cp', value: 300 }, 'b', 'w')).toBe(-300);
  });
  it('mate +5 to side-to-move = +99995cp', () => {
    expect(cpFromSide({ type: 'mate', value: 5 }, 'w', 'w')).toBe(99_995);
  });
});

describe('isMate*', () => {
  it('isMateScore', () => {
    expect(isMateScore({ type: 'mate', value: 1 })).toBe(true);
    expect(isMateScore({ type: 'cp', value: 100 })).toBe(false);
  });
  it('isMateForSideToMove', () => {
    expect(isMateForSideToMove({ type: 'mate', value: 3 })).toBe(true);
    expect(isMateForSideToMove({ type: 'mate', value: -3 })).toBe(false);
    expect(isMateForSideToMove({ type: 'cp', value: 100 })).toBe(false);
  });
});

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

describe('wdlFromSide', () => {
  it('same side: as-is', () => {
    expect(wdlFromSide({ w: 700, d: 300, l: 0 }, 'w', 'w')).toBeCloseTo(0.7);
  });
  it('opposite side: invert', () => {
    expect(wdlFromSide({ w: 700, d: 300, l: 0 }, 'b', 'w')).toBeCloseTo(-0.7);
  });
});
