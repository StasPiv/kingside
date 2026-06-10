/**
 * KS-4033. Тесты `buildCurrentPositionMetricRows` — агрегатор строк
 * таблицы метрик одной позиции.
 */
import { describe, it, expect } from 'vitest';
import type { PositionalSubterm } from '@kingside/shared';
import { buildCurrentPositionMetricRows } from './currentPositionMetricRows';

function sub(
  id: string,
  color: 'w' | 'b' | undefined,
  value_mg: number,
  value_eg: number,
): PositionalSubterm {
  return {
    id: id as PositionalSubterm['id'],
    color,
    square: undefined,
    value_mg,
    value_eg,
  } as PositionalSubterm;
}

describe('buildCurrentPositionMetricRows (KS-4033)', () => {
  describe('owner-signed подкомпоненты (pawn_*, mobility_*, …)', () => {
    it('суммирует значения по сторонам и считает diff = w − b', () => {
      const subterms: PositionalSubterm[] = [
        sub('pawn_connected', 'w', 10, 8),
        sub('pawn_connected', 'w', 5, 4),
        sub('pawn_connected', 'b', 6, 5),
      ];
      const rows = buildCurrentPositionMetricRows(subterms);
      const row = rows.find((r) => r.id === 'pawn_connected')!;
      // mix = (mg + eg) / 2 = (15+12)/2 у белых, (6+5)/2 у чёрных
      expect(row.white).toBeCloseTo(13.5, 5);
      expect(row.black).toBeCloseTo(5.5, 5);
      expect(row.diff).toBeCloseTo(8, 5);
      expect(row.score).toBeCloseTo(8, 5);
      expect(row.whiteSigned).toBe(false);
    });

    it('phase=mg использует только value_mg', () => {
      const subterms: PositionalSubterm[] = [
        sub('mobility_knight', 'w', 20, 5),
        sub('mobility_knight', 'b', 10, 4),
      ];
      const rows = buildCurrentPositionMetricRows(subterms, 'mg');
      expect(rows[0].white).toBe(20);
      expect(rows[0].black).toBe(10);
      expect(rows[0].diff).toBe(10);
    });

    it('phase=eg использует только value_eg', () => {
      const subterms: PositionalSubterm[] = [
        sub('mobility_knight', 'w', 20, 5),
        sub('mobility_knight', 'b', 10, 4),
      ];
      const rows = buildCurrentPositionMetricRows(subterms, 'eg');
      expect(rows[0].white).toBe(5);
      expect(rows[0].black).toBe(4);
      expect(rows[0].diff).toBe(1);
    });
  });

  describe('white-signed подкомпоненты (psqt_*, material, imbalance)', () => {
    it('psqt_pawn: положительная сумма → весь столбик у белых', () => {
      const subterms: PositionalSubterm[] = [
        sub('psqt_pawn', 'w', 50, 30),
        sub('psqt_pawn', 'w', -20, -10),
        sub('psqt_pawn', 'b', -10, -5),
      ];
      // sum mix = ((50-20-10)+(30-10-5))/2 = (20+15)/2 = 17.5
      const rows = buildCurrentPositionMetricRows(subterms);
      const row = rows.find((r) => (r.id as string) === 'psqt_pawn')!;
      expect(row.white).toBeCloseTo(17.5, 5);
      expect(row.black).toBe(0);
      expect(row.diff).toBeCloseTo(17.5, 5);
      expect(row.whiteSigned).toBe(true);
    });

    it('material: отрицательная сумма → весь столбик у чёрных', () => {
      const subterms: PositionalSubterm[] = [
        sub('material', undefined, -200, -180),
      ];
      const rows = buildCurrentPositionMetricRows(subterms);
      const row = rows.find((r) => (r.id as string) === 'material')!;
      expect(row.white).toBe(0);
      expect(row.black).toBe(190); // |(-200 + -180)/2|
      expect(row.diff).toBe(-190);
    });
  });

  describe('сортировка', () => {
    it('по убыванию |diff| — самая весомая метрика сверху', () => {
      const subterms: PositionalSubterm[] = [
        sub('pawn_connected', 'w', 2, 2), // diff = 2
        sub('mobility_knight', 'w', 50, 50), // diff = 50
        sub('threat_hanging', 'b', 10, 10), // diff = -10
      ];
      const rows = buildCurrentPositionMetricRows(subterms);
      expect(rows.map((r) => r.id)).toEqual([
        'mobility_knight',
        'threat_hanging',
        'pawn_connected',
      ]);
    });

    it('при равных score — стабильный порядок по id (алфавит)', () => {
      const subterms: PositionalSubterm[] = [
        sub('pawn_isolated', 'w', 5, 5),
        sub('pawn_backward', 'w', 5, 5),
      ];
      const rows = buildCurrentPositionMetricRows(subterms);
      expect(rows.map((r) => r.id)).toEqual([
        'pawn_backward',
        'pawn_isolated',
      ]);
    });
  });

  it('пустой массив subterms → пустой результат', () => {
    expect(buildCurrentPositionMetricRows([])).toEqual([]);
  });

  it('игнорирует subterms с не-конечными value_mg', () => {
    const subterms: PositionalSubterm[] = [
      sub('pawn_connected', 'w', Number.NaN, 5),
      sub('pawn_connected', 'b', 3, 3),
    ];
    const rows = buildCurrentPositionMetricRows(subterms);
    // NaN-запись от белых отброшена, но чёрная остаётся.
    const row = rows.find((r) => r.id === 'pawn_connected')!;
    expect(row.white).toBe(0);
    expect(row.black).toBe(3);
  });
});
