import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BLIND_BOARD_CONFIG,
  type BlindBoardConfig,
} from '@kingside/shared';

import {
  countByType,
  isValidBlindBoardConfig,
  remainingCapacity,
  remainingQuota,
  totalByType,
  validateBlindBoardConfig,
} from './blindBoardConfigValidation';

/**
 * KS-3488 (ADR-088 V2 §15 F1) — валидация конфига должна 1:1
 * совпадать с backend S2: minStart=3, maxTotal=7, квоты Q≤1/R≤2/B≤2/N≤2,
 * memorize-time ∈ {3,5,10}.
 */

describe('blindBoardConfigValidation', () => {
  it('countByType считает по типам', () => {
    expect(countByType(['Q', 'R', 'R', 'N'])).toEqual({
      Q: 1,
      R: 2,
      B: 0,
      N: 1,
    });
  });

  it('totalByType суммирует startPieces + addOrder', () => {
    expect(totalByType(['Q', 'N'], ['B', 'B'])).toEqual({
      Q: 1,
      R: 0,
      B: 2,
      N: 1,
    });
  });

  it('default config валиден', () => {
    expect(isValidBlindBoardConfig(DEFAULT_BLIND_BOARD_CONFIG)).toBe(true);
    expect(validateBlindBoardConfig(DEFAULT_BLIND_BOARD_CONFIG)).toEqual([]);
  });

  it('< 3 startPieces → min-start', () => {
    const cfg: BlindBoardConfig = {
      startPieces: ['Q', 'R'],
      addOrder: [],
      memorizeTimeSec: 5,
    };
    expect(validateBlindBoardConfig(cfg)).toContain('min-start');
  });

  it('> 7 total → max-total', () => {
    const cfg: BlindBoardConfig = {
      startPieces: ['Q', 'R', 'R', 'B', 'B', 'N', 'N'],
      addOrder: ['Q'],
      memorizeTimeSec: 5,
    };
    expect(validateBlindBoardConfig(cfg)).toContain('max-total');
  });

  it('> квоты по типу → quota', () => {
    const cfg: BlindBoardConfig = {
      startPieces: ['R', 'R', 'R'], // 3 R, квота 2.
      addOrder: [],
      memorizeTimeSec: 5,
    };
    expect(validateBlindBoardConfig(cfg)).toContain('quota');
  });

  it('memorize 4 не в whitelist → memorize-time', () => {
    const cfg: BlindBoardConfig = {
      startPieces: ['Q', 'R', 'N'],
      addOrder: [],
      memorizeTimeSec: 4,
    };
    expect(validateBlindBoardConfig(cfg)).toContain('memorize-time');
  });

  it('remainingCapacity = max(0, 7 - total)', () => {
    expect(
      remainingCapacity({
        startPieces: ['Q', 'R'],
        addOrder: ['B'],
        memorizeTimeSec: 5,
      }),
    ).toBe(4);
  });

  it('remainingQuota по типу учитывает оба массива', () => {
    const cfg: BlindBoardConfig = {
      startPieces: ['Q', 'R'],
      addOrder: ['R'], // R уже 2 — квота исчерпана.
      memorizeTimeSec: 5,
    };
    expect(remainingQuota(cfg, 'R')).toBe(0);
    expect(remainingQuota(cfg, 'B')).toBe(2);
  });
});
