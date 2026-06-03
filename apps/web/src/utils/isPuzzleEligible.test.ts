/**
 * KS-3642 / ADR-106 §2.6. Тесты pure-функции `isPuzzleEligible` с
 * инвертированной семантикой (высокая `maiaWeakChoiceProb` = пазл
 * остаётся в выдаче) и проверкой `maiaMetricVersion`.
 */
import { describe, it, expect } from 'vitest';

import { isPuzzleEligible } from './isPuzzleEligible';
import { MAIA_METRIC_VERSION } from '../config/precisionMaiaThreshold';

/** Хелпер: пазл с актуальной версией метрики. */
function p(
  prob: number | null | undefined,
  version: number | null | undefined = MAIA_METRIC_VERSION,
) {
  return { maiaWeakChoiceProb: prob, maiaMetricVersion: version };
}

describe('isPuzzleEligible — ADR-106 инвертированная семантика', () => {
  describe('null/undefined значения — safe fallback (true)', () => {
    it('maiaWeakChoiceProb === null → true (пазл не размечен)', () => {
      expect(isPuzzleEligible(p(null), 0.3)).toBe(true);
    });

    it('maiaWeakChoiceProb === undefined → true (старый PuzzleDto)', () => {
      expect(isPuzzleEligible({}, 0.3)).toBe(true);
    });

    it('NaN / Infinity → true (нечитаемое значение, не отсеиваем)', () => {
      expect(isPuzzleEligible(p(NaN), 0.3)).toBe(true);
      expect(isPuzzleEligible(p(Infinity), 0.3)).toBe(true);
    });
  });

  describe('maiaMetricVersion проверка', () => {
    it('version === null → true (значение есть, но не версионировано)', () => {
      expect(isPuzzleEligible(p(0.1, null), 0.3)).toBe(true);
      // Даже когда сам prob ниже порога — пазл всё равно пускаем,
      // потому что версия не подтверждена.
    });

    it('version отсутствует → true', () => {
      expect(
        isPuzzleEligible({ maiaWeakChoiceProb: 0.1 }, 0.3),
      ).toBe(true);
    });

    it('version отличается от текущей → true (значение от устаревшего алгоритма)', () => {
      // Имитируем старую разметку ADR-104: version 0 (или любое другое
      // не-MAIA_METRIC_VERSION).
      const oldVersion = MAIA_METRIC_VERSION + 1;
      expect(isPuzzleEligible(p(0.1, oldVersion), 0.3)).toBe(true);
      expect(isPuzzleEligible(p(0.9, oldVersion), 0.3)).toBe(true);
    });

    it('version совпадает с текущей → применяется фильтр по порогу', () => {
      expect(isPuzzleEligible(p(0.1, MAIA_METRIC_VERSION), 0.3)).toBe(false);
      expect(isPuzzleEligible(p(0.5, MAIA_METRIC_VERSION), 0.3)).toBe(true);
    });
  });

  describe('фильтр по порогу при актуальной версии', () => {
    it('maiaWeakChoiceProb >= threshold → true (пазл остаётся)', () => {
      expect(isPuzzleEligible(p(0.3), 0.3)).toBe(true);
      expect(isPuzzleEligible(p(0.5), 0.3)).toBe(true);
      expect(isPuzzleEligible(p(1), 0.3)).toBe(true);
    });

    it('maiaWeakChoiceProb < threshold → false (отсеивается)', () => {
      expect(isPuzzleEligible(p(0.29), 0.3)).toBe(false);
      expect(isPuzzleEligible(p(0.1), 0.3)).toBe(false);
      expect(isPuzzleEligible(p(0), 0.3)).toBe(false);
    });

    it('кастомный threshold', () => {
      expect(isPuzzleEligible(p(0.5), 0.6)).toBe(false);
      expect(isPuzzleEligible(p(0.7), 0.6)).toBe(true);
    });

    it('threshold = 1.0 → откат фильтра (только prob === 1 проходит)', () => {
      expect(isPuzzleEligible(p(0.99), 1)).toBe(false);
      expect(isPuzzleEligible(p(1), 1)).toBe(true);
      // NULL по-прежнему проходит (safe fallback).
      expect(isPuzzleEligible(p(null), 1)).toBe(true);
    });
  });
});
