import { cpFromSide, isMateScore, isMateForSideToMove } from './score';

describe('cpFromSide', () => {
  it('cp same side: identity', () => {
    expect(
      cpFromSide({ type: 'cp', value: 300 }, 'w', 'w'),
    ).toBe(300);
  });

  it('cp opposite side: invert', () => {
    expect(
      cpFromSide({ type: 'cp', value: 300 }, 'b', 'w'),
    ).toBe(-300);
  });

  it('mate +5 to side-to-move = ~+99995 cp от его лица', () => {
    expect(cpFromSide({ type: 'mate', value: 5 }, 'w', 'w')).toBe(99_995);
  });

  it('mate -3 to side-to-move = ~-99997 cp от его лица', () => {
    expect(cpFromSide({ type: 'mate', value: -3 }, 'w', 'w')).toBe(-99_997);
  });

  it('mate +5 от лица другой стороны = инвертированный cp', () => {
    expect(cpFromSide({ type: 'mate', value: 5 }, 'b', 'w')).toBe(-99_995);
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
    expect(isMateForSideToMove({ type: 'cp', value: 1000 })).toBe(false);
  });
});
