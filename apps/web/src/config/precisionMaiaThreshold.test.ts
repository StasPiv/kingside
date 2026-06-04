/**
 * KS-3634 / ADR-104 §9. Тесты `readPrecisionMaiaThreshold` —
 * localStorage override и его валидация.
 */
import { describe, it, expect } from 'vitest';

import {
  PRECISION_MAIA_DEFAULT_RANGE,
  PRECISION_MAIA_DEFAULT_THRESHOLD,
  PRECISION_MAIA_RANGE_STORAGE_KEY,
  PRECISION_MAIA_THRESHOLD_STORAGE_KEY,
  readPrecisionMaiaRange,
  readPrecisionMaiaThreshold,
  writePrecisionMaiaRange,
} from './precisionMaiaThreshold';

function mockStorage(value: string | null): Pick<Storage, 'getItem'> {
  return {
    getItem(key: string): string | null {
      if (key === PRECISION_MAIA_THRESHOLD_STORAGE_KEY) return value;
      return null;
    },
  };
}

/**
 * Полный мок Storage с двумя ключами (range + legacy single). Возвращает
 * объект с `getItem` и `setItem`, плюс доступ к внутреннему состоянию
 * (`data`) для проверок записи.
 */
function fullMockStorage(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem(key: string): string | null {
      return key in data ? data[key] : null;
    },
    setItem(key: string, value: string): void {
      data[key] = value;
    },
  };
}

describe('readPrecisionMaiaThreshold', () => {
  it('константа = 0.3 (ADR-106 §2.6)', () => {
    expect(PRECISION_MAIA_DEFAULT_THRESHOLD).toBe(0.3);
  });

  it('storage отсутствует → дефолт', () => {
    expect(readPrecisionMaiaThreshold(null)).toBe(
      PRECISION_MAIA_DEFAULT_THRESHOLD,
    );
  });

  it('ключ не задан → дефолт', () => {
    expect(readPrecisionMaiaThreshold(mockStorage(null))).toBe(
      PRECISION_MAIA_DEFAULT_THRESHOLD,
    );
  });

  it('пустая строка → дефолт', () => {
    expect(readPrecisionMaiaThreshold(mockStorage(''))).toBe(
      PRECISION_MAIA_DEFAULT_THRESHOLD,
    );
    expect(readPrecisionMaiaThreshold(mockStorage('   '))).toBe(
      PRECISION_MAIA_DEFAULT_THRESHOLD,
    );
  });

  it('валидное число в [0, 1] → используется', () => {
    expect(readPrecisionMaiaThreshold(mockStorage('0'))).toBe(0);
    expect(readPrecisionMaiaThreshold(mockStorage('0.7'))).toBe(0.7);
    expect(readPrecisionMaiaThreshold(mockStorage('1'))).toBe(1);
  });

  it('число вне диапазона → дефолт', () => {
    expect(readPrecisionMaiaThreshold(mockStorage('-0.1'))).toBe(
      PRECISION_MAIA_DEFAULT_THRESHOLD,
    );
    expect(readPrecisionMaiaThreshold(mockStorage('1.5'))).toBe(
      PRECISION_MAIA_DEFAULT_THRESHOLD,
    );
  });

  it('невалидная строка (не число) → дефолт', () => {
    expect(readPrecisionMaiaThreshold(mockStorage('not-a-number'))).toBe(
      PRECISION_MAIA_DEFAULT_THRESHOLD,
    );
    expect(readPrecisionMaiaThreshold(mockStorage('NaN'))).toBe(
      PRECISION_MAIA_DEFAULT_THRESHOLD,
    );
  });

  it('storage.getItem кидает исключение → дефолт (graceful)', () => {
    const throwingStorage: Pick<Storage, 'getItem'> = {
      getItem() {
        throw new Error('localStorage disabled (private mode)');
      },
    };
    expect(readPrecisionMaiaThreshold(throwingStorage)).toBe(
      PRECISION_MAIA_DEFAULT_THRESHOLD,
    );
  });
});

describe('readPrecisionMaiaRange (KS-3665)', () => {
  it('дефолт = {min: 0.3, max: 1} (ADR-106 §2.6)', () => {
    expect(PRECISION_MAIA_DEFAULT_RANGE).toEqual({ min: 0.3, max: 1 });
  });

  it('storage отсутствует → дефолт', () => {
    expect(readPrecisionMaiaRange(null)).toEqual(PRECISION_MAIA_DEFAULT_RANGE);
  });

  it('range-ключ задан валидным JSON → используется', () => {
    const s = fullMockStorage({
      [PRECISION_MAIA_RANGE_STORAGE_KEY]: JSON.stringify({
        min: 0.4,
        max: 0.7,
      }),
    });
    expect(readPrecisionMaiaRange(s)).toEqual({ min: 0.4, max: 0.7 });
  });

  it('range-ключ невалиден (min > max) → дефолт', () => {
    const s = fullMockStorage({
      [PRECISION_MAIA_RANGE_STORAGE_KEY]: JSON.stringify({
        min: 0.9,
        max: 0.2,
      }),
    });
    expect(readPrecisionMaiaRange(s)).toEqual(PRECISION_MAIA_DEFAULT_RANGE);
  });

  it('range-ключ невалиден (значение вне [0, 1]) → дефолт', () => {
    const s = fullMockStorage({
      [PRECISION_MAIA_RANGE_STORAGE_KEY]: JSON.stringify({
        min: -0.1,
        max: 0.5,
      }),
    });
    expect(readPrecisionMaiaRange(s)).toEqual(PRECISION_MAIA_DEFAULT_RANGE);
  });

  it('range-ключ невалиден (битый JSON) → fallback на legacy single-key', () => {
    const s = fullMockStorage({
      [PRECISION_MAIA_RANGE_STORAGE_KEY]: 'not-a-json',
      [PRECISION_MAIA_THRESHOLD_STORAGE_KEY]: '0.5',
    });
    expect(readPrecisionMaiaRange(s)).toEqual({ min: 0.5, max: 1 });
  });

  it('range-ключ отсутствует, legacy single-key задан → fallback {min: legacy, max: 1}', () => {
    const s = fullMockStorage({
      [PRECISION_MAIA_THRESHOLD_STORAGE_KEY]: '0.6',
    });
    expect(readPrecisionMaiaRange(s)).toEqual({ min: 0.6, max: 1 });
  });

  it('оба ключа пусты → дефолтный range', () => {
    const s = fullMockStorage({});
    expect(readPrecisionMaiaRange(s)).toEqual(PRECISION_MAIA_DEFAULT_RANGE);
  });
});

describe('writePrecisionMaiaRange (KS-3665)', () => {
  it('пишет JSON в range-ключ и min в legacy single-key', () => {
    const s = fullMockStorage();
    writePrecisionMaiaRange({ min: 0.4, max: 0.7 }, s);
    expect(JSON.parse(s.data[PRECISION_MAIA_RANGE_STORAGE_KEY])).toEqual({
      min: 0.4,
      max: 0.7,
    });
    expect(s.data[PRECISION_MAIA_THRESHOLD_STORAGE_KEY]).toBe('0.40');
  });

  it('clamp выходящие значения в [0, 1] и max >= min', () => {
    const s = fullMockStorage();
    writePrecisionMaiaRange({ min: -0.5, max: 1.5 }, s);
    expect(JSON.parse(s.data[PRECISION_MAIA_RANGE_STORAGE_KEY])).toEqual({
      min: 0,
      max: 1,
    });
  });

  it('storage отсутствует → silent no-op', () => {
    expect(() =>
      writePrecisionMaiaRange({ min: 0.4, max: 0.7 }, null),
    ).not.toThrow();
  });

  it('setItem кидает → не падает', () => {
    const throwingStorage: Pick<Storage, 'setItem'> = {
      setItem() {
        throw new Error('private mode');
      },
    };
    expect(() =>
      writePrecisionMaiaRange({ min: 0.4, max: 0.7 }, throwingStorage),
    ).not.toThrow();
  });
});
