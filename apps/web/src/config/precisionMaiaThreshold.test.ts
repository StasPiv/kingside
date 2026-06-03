/**
 * KS-3634 / ADR-104 §9. Тесты `readPrecisionMaiaThreshold` —
 * localStorage override и его валидация.
 */
import { describe, it, expect } from 'vitest';

import {
  PRECISION_MAIA_DEFAULT_THRESHOLD,
  PRECISION_MAIA_THRESHOLD_STORAGE_KEY,
  readPrecisionMaiaThreshold,
} from './precisionMaiaThreshold';

function mockStorage(value: string | null): Pick<Storage, 'getItem'> {
  return {
    getItem(key: string): string | null {
      if (key === PRECISION_MAIA_THRESHOLD_STORAGE_KEY) return value;
      return null;
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
