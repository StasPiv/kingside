/**
 * KS-4024 — юнит-тесты агрегатора позиционных метрик для UI вкладки
 * Metrics. Проверяем:
 *  - METRIC_GROUPS покрывают все основные id без дублей;
 *  - aggregatePlySubterms суммирует value_mg/eg по сторонам корректно;
 *  - выбор фазы (mg/eg/mix) меняет значение;
 *  - buildMetricSeries в режиме by-side даёт две серии на id, в diff —
 *    одну с правильной разницей.
 */
import { describe, it, expect } from 'vitest';
import type { PositionalSubterm } from '@kingside/shared';
import {
  METRIC_GROUPS,
  aggregatePlySubterms,
  buildMetricSeries,
} from './positionalMetrics';

function s(id: string, color: 'w' | 'b' | undefined, mg: number, eg: number): PositionalSubterm {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { id, color, value_mg: mg, value_eg: eg } as any;
}

describe('METRIC_GROUPS', () => {
  it('каждый id уникален между группами', () => {
    const seen = new Set<string>();
    for (const g of METRIC_GROUPS) {
      for (const id of g.ids) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });

  it('покрывает ключевые id (pawn_connected, material, threat_hanging)', () => {
    const all = new Set(METRIC_GROUPS.flatMap((g) => g.ids));
    expect(all.has('pawn_connected')).toBe(true);
    expect(all.has('material')).toBe(true);
    expect(all.has('threat_hanging')).toBe(true);
    expect(all.has('passed_rank')).toBe(true);
  });
});

describe('aggregatePlySubterms', () => {
  it('суммирует по сторонам и считает diff', () => {
    const input: PositionalSubterm[] = [
      s('pawn_connected', 'w', 0.2, 0.3),
      s('pawn_connected', 'w', 0.1, 0.15),
      s('pawn_connected', 'b', 0.15, 0.2),
      s('outpost_knight', 'w', 0.4, 0.25),
    ];
    const out = aggregatePlySubterms(
      input,
      new Set(['pawn_connected', 'outpost_knight']),
      'mg',
    );
    expect(out.white.get('pawn_connected')).toBeCloseTo(0.3, 5);
    expect(out.black.get('pawn_connected')).toBeCloseTo(0.15, 5);
    expect(out.diff.get('pawn_connected')).toBeCloseTo(0.15, 5);
    expect(out.white.get('outpost_knight')).toBeCloseTo(0.4, 5);
    expect(out.diff.get('outpost_knight')).toBeCloseTo(0.4, 5);
  });

  it('фильтрует по выбранным ids', () => {
    const input: PositionalSubterm[] = [
      s('pawn_connected', 'w', 1, 1),
      s('outpost_knight', 'w', 2, 2),
    ];
    const out = aggregatePlySubterms(input, new Set(['pawn_connected']), 'mg');
    expect(out.white.has('pawn_connected')).toBe(true);
    expect(out.white.has('outpost_knight')).toBe(false);
  });

  it('фаза mg/eg/mix даёт разные значения', () => {
    const input: PositionalSubterm[] = [s('material', undefined, 1.0, 2.0)];
    const ids = new Set(['material']);
    expect(aggregatePlySubterms(input, ids, 'mg').white.get('material')).toBe(1.0);
    expect(aggregatePlySubterms(input, ids, 'eg').white.get('material')).toBe(2.0);
    expect(aggregatePlySubterms(input, ids, 'mix').white.get('material')).toBe(1.5);
  });

  it('side-agnostic подкомпонента (без color) идёт в белые', () => {
    const input: PositionalSubterm[] = [s('material', undefined, 1.0, 1.2)];
    const out = aggregatePlySubterms(input, new Set(['material']), 'mg');
    expect(out.white.get('material')).toBe(1.0);
    expect(out.black.get('material')).toBeUndefined();
    expect(out.diff.get('material')).toBe(1.0);
  });
});

describe('buildMetricSeries', () => {
  const plies = [
    { ply: 0, subterms: [s('pawn_connected', 'w', 0.1, 0.1), s('pawn_connected', 'b', 0.1, 0.1)] },
    { ply: 1, subterms: [s('pawn_connected', 'w', 0.2, 0.2), s('pawn_connected', 'b', 0.15, 0.15)] },
  ];

  it('by-side: две серии на id', () => {
    const series = buildMetricSeries(plies, new Set(['pawn_connected']), 'by-side', 'mg');
    expect(series).toHaveLength(2);
    expect(series[0].variant).toBe('w');
    expect(series[0].data).toEqual([0.1, 0.2]);
    expect(series[1].variant).toBe('b');
    expect(series[1].data).toEqual([0.1, 0.15]);
  });

  it('diff: одна серия с разницей', () => {
    const series = buildMetricSeries(plies, new Set(['pawn_connected']), 'diff', 'mg');
    expect(series).toHaveLength(1);
    expect(series[0].variant).toBe('diff');
    expect(series[0].data[0]).toBeCloseTo(0, 5);
    expect(series[0].data[1]).toBeCloseTo(0.05, 5);
  });

  it('пустые ply — пустые серии', () => {
    expect(buildMetricSeries([], new Set(['pawn_connected']), 'diff', 'mg')).toEqual([]);
  });
});
