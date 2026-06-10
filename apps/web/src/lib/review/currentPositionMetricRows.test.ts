/**
 * KS-4033. Тесты `buildCurrentPositionMetricRows` — агрегатор строк
 * таблицы метрик одной позиции.
 */
import { describe, it, expect } from 'vitest';
import type { PositionalSubterm } from '@kingside/shared';
import {
  buildCurrentPositionMetricRows,
  squaresForMetric,
} from './currentPositionMetricRows';

function sub(
  id: string,
  color: 'w' | 'b' | undefined,
  value_mg: number,
  value_eg: number,
  square?: string,
): PositionalSubterm {
  return {
    id: id as PositionalSubterm['id'],
    color,
    square,
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

describe('squaresForMetric (KS-4033 follow-up)', () => {
  it('возвращает раздельные списки клеток по сторонам, дедуп и сортировка', () => {
    const subterms = [
      sub('pawn_isolated', 'w', 5, 5, 'd4'),
      sub('pawn_isolated', 'w', 5, 5, 'a2'),
      sub('pawn_isolated', 'w', 5, 5, 'a2'), // дубль
      sub('pawn_isolated', 'b', 4, 4, 'h7'),
    ];
    expect(squaresForMetric(subterms, 'pawn_isolated')).toEqual({
      white: ['a2', 'd4'],
      black: ['h7'],
    });
  });

  it('игнорирует подкомпоненты другого id', () => {
    const subterms = [
      sub('pawn_isolated', 'w', 5, 5, 'd4'),
      sub('pawn_backward', 'w', 5, 5, 'e5'),
    ];
    expect(squaresForMetric(subterms, 'pawn_isolated')).toEqual({
      white: ['d4'],
      black: [],
    });
  });

  it('игнорирует записи без square (агрегаты вроде material)', () => {
    const subterms = [
      sub('material', undefined, -200, -180),
      sub('material', undefined, 0, 0, 'invalid'),
    ];
    expect(squaresForMetric(subterms, 'material')).toEqual({
      white: [],
      black: [],
    });
  });

  /**
   * KS-4038. Жалоба пользователя (/tmp/telegram/326131471_0.jpg):
   * на доске с белыми пешками a2, b2, e3, f2, g2, h3 для метрики
   * `pawn_connected` подсвечены a2, b2 и h3, а g2 (защищает h3 и
   * сама в phalanx с f2) — пропущена. Stockfish выдаёт `square`
   * только для пешек, которым присуждён бонус, остальные звенья
   * цепочки восстанавливаем по FEN (phalanx + supporter + supported).
   */
  describe('pawn_connected: дополняем по FEN до полной связанной группы (KS-4038)', () => {
    // FEN ровно для расстановки со скриншота (упрощённо — короли + пешки).
    // KS-4038: добавили чёрного короля e8 — без него chess.js считает
    // FEN невалидным и отказывается парсить позицию.
    const FEN_USER =
      '4k3/2p2p2/8/3p4/8/4P2P/PP3PP1/7K w - - 0 1';
    // Stockfish отметил h3 (одиночная запись из его trace).
    const SUBTERMS_SF_PARTIAL = [
      sub('pawn_connected', 'w', 5, 5, 'h3'),
    ];

    it('без fen — возвращаем только то что SF отметил (как раньше)', () => {
      expect(
        squaresForMetric(SUBTERMS_SF_PARTIAL, 'pawn_connected'),
      ).toEqual({
        white: ['h3'],
        black: [],
      });
    });

    it('с fen — добавляем g2 (supporter h3) и f2 (phalanx с g2)', () => {
      expect(
        squaresForMetric(SUBTERMS_SF_PARTIAL, 'pawn_connected', {
          fen: FEN_USER,
        }),
      ).toEqual({
        white: ['f2', 'g2', 'h3'],
        black: [],
      });
    });

    it('phalanx-пара a2/b2 расширяется в обе стороны от любой из них', () => {
      const subterms = [
        sub('pawn_connected', 'w', 4, 4, 'a2'),
      ];
      const out = squaresForMetric(subterms, 'pawn_connected', {
        fen: FEN_USER,
      });
      // a2 ↔ b2 phalanx; b2 связана с другими частями набора через
      // soft-цепочку. Минимум — добавлена b2.
      expect(out.white).toContain('a2');
      expect(out.white).toContain('b2');
    });

    it('seed=e3 расширяется только до f2 (supporter), но НЕ дальше', () => {
      const subterms = [
        sub('pawn_connected', 'w', 1, 1, 'e3'),
      ];
      // По определению Stockfish-connected: для seed=e3 (белая)
      // supporter = пешка на одну горизонталь сзади (rank 2) на
      // соседнем файле = d2/f2. d2 нет, f2 есть → +f2.
      // f2 phalanx с e2/g2. e2 нет, g2 есть → +g2. И так далее.
      // Это уже путь обратной цепочки. Ничего за рамки группы
      // f2-g2-h3 НЕ выходит — h3 не supporter для f2/g2, а ahead
      // для них (направление supported), его не добавим из этой
      // стороны, но он уже в наборе если был seed; в данном тесте
      // seed только e3.
      const out = squaresForMetric(subterms, 'pawn_connected', {
        fen: FEN_USER,
      });
      expect(out.white).toEqual(
        expect.arrayContaining(['e3', 'f2', 'g2']),
      );
      // h3 НЕ добавится из seed=e3 — он впереди f2/g2 по направлению
      // движения, не supporter.
      expect(out.white).not.toContain('h3');
    });

    it('невалидный FEN — fallback без расширения, ошибки нет', () => {
      const subterms = [
        sub('pawn_connected', 'w', 5, 5, 'h3'),
      ];
      expect(
        squaresForMetric(subterms, 'pawn_connected', {
          fen: 'это не fen',
        }),
      ).toEqual({
        white: ['h3'],
        black: [],
      });
    });

    it('другие метрики (mobility_*, threat_*) НЕ расширяются по FEN', () => {
      const subterms = [
        sub('mobility_knight', 'w', 5, 5, 'h3'),
      ];
      expect(
        squaresForMetric(subterms, 'mobility_knight', {
          fen: FEN_USER,
        }),
      ).toEqual({
        white: ['h3'],
        black: [],
      });
    });
  });
});
