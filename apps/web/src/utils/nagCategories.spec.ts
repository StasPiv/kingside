import { describe, it, expect } from 'vitest';

import {
  groupNagsByCategory,
  nagCategory,
  POSITION_EVAL_NAGS,
  QUALITY_NAGS,
  setNagInCategory,
} from './nagCategories';

/**
 * KS-2266 (ADR-037 §1, §6, этап E1) — категории NAG и
 * `setNagInCategory(nags, newNag)`.
 *
 * Покрытие:
 *   - replace within group (`!` → `!!` даёт `[3]`, не `[1,3]`).
 *   - toggle off (повторный клик `!!` снимает).
 *   - multi-category coexistence (`!` + `⩲` оба остаются).
 *   - NAG вне категорий (например `7 □`) ведёт себя как обычный toggle.
 *   - groupNagsByCategory возвращает по одному NAG из каждой категории.
 */

describe('nagCategory', () => {
  it('quality NAGs (1..6) → "quality"', () => {
    for (const n of QUALITY_NAGS) {
      expect(nagCategory(n)).toBe('quality');
    }
  });

  it('position-eval NAGs (10, 13..19) → "positionEval"', () => {
    for (const n of POSITION_EVAL_NAGS) {
      expect(nagCategory(n)).toBe('positionEval');
    }
  });

  it('NAG вне категорий → null', () => {
    expect(nagCategory(7)).toBeNull(); // □ — single-move
    expect(nagCategory(42)).toBeNull(); // произвольный $42
    expect(nagCategory(0)).toBeNull();
  });
});

describe('setNagInCategory — KS-2266 / ADR-037 §6', () => {
  // ─── Replace within group (главный bug) ──────────────────────────

  it('quality replace: [1] + 3 → [3] (НЕ [1,3])', () => {
    expect(setNagInCategory([1], 3)).toEqual([3]);
  });

  it('quality replace: [3] + 5 → [5] (`!!` → `!?`, не `[3,5]`)', () => {
    expect(setNagInCategory([3], 5)).toEqual([5]);
  });

  it('quality replace: пустой → [3]', () => {
    expect(setNagInCategory([], 3)).toEqual([3]);
  });

  // ─── Toggle off ──────────────────────────────────────────────────

  it('toggle off: [3] + 3 → []', () => {
    expect(setNagInCategory([3], 3)).toEqual([]);
  });

  it('toggle off: [1, 14] + 1 → [14] (только quality снят, position-eval остался)', () => {
    expect(setNagInCategory([1, 14], 1)).toEqual([14]);
  });

  // ─── Multi-category coexistence ──────────────────────────────────

  it('quality + position-eval сосуществуют: [1] + 14 → [1, 14]', () => {
    expect(setNagInCategory([1], 14)).toEqual([1, 14]);
  });

  it('position-eval replace без затрагивания quality: [1, 14] + 16 → [1, 16]', () => {
    expect(setNagInCategory([1, 14], 16)).toEqual([1, 16]);
  });

  it('quality replace без затрагивания position-eval: [1, 14] + 3 → [14, 3]', () => {
    // Порядок: сначала NAG других категорий, потом новый.
    expect(setNagInCategory([1, 14], 3)).toEqual([14, 3]);
  });

  // ─── NAG вне категорий ───────────────────────────────────────────

  it('NAG вне категорий: [] + 7 → [7]', () => {
    expect(setNagInCategory([], 7)).toEqual([7]);
  });

  it('NAG вне категорий: [7] + 7 → [] (toggle off)', () => {
    expect(setNagInCategory([7], 7)).toEqual([]);
  });

  it('NAG вне категорий не трогает quality: [1] + 7 → [1, 7]', () => {
    expect(setNagInCategory([1], 7)).toEqual([1, 7]);
  });

  // ─── Иммутабельность ──────────────────────────────────────────────

  it('исходный массив не мутируется', () => {
    const src = [1, 14];
    const result = setNagInCategory(src, 3);
    expect(src).toEqual([1, 14]);
    expect(result).not.toBe(src);
  });
});

describe('groupNagsByCategory', () => {
  it('пустой → {}', () => {
    expect(groupNagsByCategory([])).toEqual({});
  });

  it('[1, 14] → { quality: 1, positionEval: 14 }', () => {
    expect(groupNagsByCategory([1, 14])).toEqual({
      quality: 1,
      positionEval: 14,
    });
  });

  it('игнорирует NAG вне категорий: [1, 7, 14] → { quality: 1, positionEval: 14 }', () => {
    expect(groupNagsByCategory([1, 7, 14])).toEqual({
      quality: 1,
      positionEval: 14,
    });
  });

  it('последний NAG категории выигрывает (на случай legacy-данных с дублями): [1, 3] → { quality: 3 }', () => {
    expect(groupNagsByCategory([1, 3])).toEqual({ quality: 3 });
  });
});
