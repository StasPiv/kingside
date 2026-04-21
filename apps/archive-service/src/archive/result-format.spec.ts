import { resultFilterToStorage, storageToResult } from './result-format';

describe('resultFilterToStorage', () => {
  it('maps wire filter → storage char', () => {
    expect(resultFilterToStorage('1-0')).toBe('w');
    expect(resultFilterToStorage('0-1')).toBe('b');
    expect(resultFilterToStorage('1/2-1/2')).toBe('d');
  });

  it("treats '*' as null (ongoing / unknown)", () => {
    expect(resultFilterToStorage('*')).toBeNull();
  });

  it('undefined = no filter, null = explicit NULL filter', () => {
    expect(resultFilterToStorage(undefined)).toBeUndefined();
    expect(resultFilterToStorage(null)).toBeNull();
  });
});

describe('storageToResult', () => {
  it('maps storage char → wire-format', () => {
    expect(storageToResult('w')).toBe('1-0');
    expect(storageToResult('b')).toBe('0-1');
    expect(storageToResult('d')).toBe('1/2-1/2');
  });

  it('null / unknown → null', () => {
    expect(storageToResult(null)).toBeNull();
    expect(storageToResult(undefined)).toBeNull();
    expect(storageToResult('x')).toBeNull();
    expect(storageToResult('')).toBeNull();
  });
});
