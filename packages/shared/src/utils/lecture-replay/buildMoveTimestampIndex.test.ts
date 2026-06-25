/**
 * KS-4639 / ADR-143 §10. Unit-тесты `buildMoveTimestampIndex` на
 * фикстурах F1-F8 — формальная спецификация (см. §12.1).
 *
 * Каждая фикстура — самостоятельный тест-кейс. Сравнение через
 * Map → Object (порядок ключей в Map не важен для индекса), глубокое
 * equal по содержимому. Дополнительно проверяется инвариант §5.5
 * (`endedAtMs === enteredAtMs + durationMs`, `durationMs ≥ 0`) для
 * каждого выданного `MoveVisit` — отдельным проходом, отдельным тестом.
 */
import { describe, expect, it } from 'vitest';
import { buildMoveTimestampIndex } from './buildMoveTimestampIndex.js';
import { ALL_FIXTURES } from './__fixtures__/index.js';
import {
  parseMoveKey,
  serializeMoveKey,
  type MoveTimestampIndex,
} from '../../types/lecture-replay.js';

function indexAsPlain(index: MoveTimestampIndex) {
  const visits: Record<string, Array<{ enteredAtMs: number; endedAtMs: number; durationMs: number }>> = {};
  for (const [key, arr] of index.visits.entries()) {
    visits[key] = arr.map((v) => ({
      enteredAtMs: v.enteredAtMs,
      endedAtMs: v.endedAtMs,
      durationMs: v.durationMs,
    }));
  }
  return {
    visits,
    segmentBoundaries: index.segmentBoundaries.map((b) => ({
      segment: b.segment,
      startedAtMs: b.startedAtMs,
      endedAtMs: b.endedAtMs,
      title: b.title,
    })),
    totalDurationMs: index.totalDurationMs,
  };
}

describe('buildMoveTimestampIndex — фикстуры F1-F8 (ADR-143 §10)', () => {
  for (const fixture of ALL_FIXTURES) {
    it(`${fixture.label}: ${fixture.description}`, () => {
      const index = buildMoveTimestampIndex(
        fixture.events,
        fixture.totalDurationMs,
      );
      expect(indexAsPlain(index)).toEqual(fixture.expected);
    });
  }
});

describe('buildMoveTimestampIndex — инварианты ADR-143 §5.5', () => {
  for (const fixture of ALL_FIXTURES) {
    it(`${fixture.label}: каждый visit удовлетворяет endedAtMs===enteredAtMs+durationMs и durationMs>=0`, () => {
      const index = buildMoveTimestampIndex(
        fixture.events,
        fixture.totalDurationMs,
      );
      for (const [, arr] of index.visits.entries()) {
        expect(arr.length).toBeGreaterThan(0); // §4.2 инвариант 2
        for (const visit of arr) {
          expect(visit.durationMs).toBeGreaterThanOrEqual(0);
          expect(visit.endedAtMs).toBe(visit.enteredAtMs + visit.durationMs);
        }
        // §4.2 инвариант 2: отсортированы по enteredAtMs возрастанию.
        for (let i = 1; i < arr.length; i++) {
          expect(arr[i].enteredAtMs).toBeGreaterThanOrEqual(
            arr[i - 1].enteredAtMs,
          );
        }
      }
    });

    it(`${fixture.label}: segmentBoundaries[i].segment === i и все endedAtMs заполнены`, () => {
      const index = buildMoveTimestampIndex(
        fixture.events,
        fixture.totalDurationMs,
      );
      const boundaries = index.segmentBoundaries;
      expect(boundaries.length).toBeGreaterThan(0);
      for (let i = 0; i < boundaries.length; i++) {
        expect(boundaries[i].segment).toBe(i);
        // §4.2 инвариант 3: все endedAtMs заполнены — финализация
        // builder'а обязана это гарантировать. Для последнего
        // boundary endedAtMs — totalDurationMs (или раньше, если
        // запись закончилась на closed).
        expect(boundaries[i].endedAtMs).not.toBeNull();
        expect(boundaries[i].endedAtMs!).toBeGreaterThanOrEqual(
          boundaries[i].startedAtMs,
        );
      }
      // Сегменты не перекрываются и идут подряд.
      for (let i = 1; i < boundaries.length; i++) {
        expect(boundaries[i].startedAtMs).toBe(boundaries[i - 1].endedAtMs);
      }
    });

    it(`${fixture.label}: все ключи visits удовлетворяют формату "<segment>:<globalIndex>"`, () => {
      const index = buildMoveTimestampIndex(
        fixture.events,
        fixture.totalDurationMs,
      );
      for (const key of index.visits.keys()) {
        const parsed = parseMoveKey(key);
        expect(Number.isInteger(parsed.segment)).toBe(true);
        expect(Number.isInteger(parsed.globalIndex)).toBe(true);
        expect(parsed.segment).toBeGreaterThanOrEqual(0);
        expect(parsed.globalIndex).toBeGreaterThanOrEqual(0);
        // Round-trip: serialize(parse(k)) === k.
        expect(serializeMoveKey(parsed)).toBe(key);
        // Сегмент существует в boundaries (нет «висячих» ключей).
        expect(parsed.segment).toBeLessThan(index.segmentBoundaries.length);
      }
    });
  }
});

describe('buildMoveTimestampIndex — пограничные случаи', () => {
  it('пустой events: visits.size === 0, один сегмент 0..totalDurationMs', () => {
    const index = buildMoveTimestampIndex([], 5000);
    expect(index.visits.size).toBe(0);
    expect(index.segmentBoundaries).toEqual([
      { segment: 0, startedAtMs: 0, endedAtMs: 5000, title: null },
    ]);
    expect(index.totalDurationMs).toBe(5000);
  });

  it('события не по порядку t → throw (§12.7)', () => {
    expect(() =>
      buildMoveTimestampIndex(
        [
          {
            t: 200,
            type: 'state-patch',
            payload: { tree: '{}', currentGlobalIndex: 0, orientation: 'white' },
          },
          // t=100 < 200 — нарушение порядка.
          {
            t: 100,
            type: 'state-patch',
            payload: { tree: '{}', currentGlobalIndex: 1, orientation: 'white' },
          },
        ],
        5000,
      ),
    ).toThrow(/out of order/);
  });

  it('несколько одинаковых currentGlobalIndex подряд → одно посещение (§8.5)', () => {
    const index = buildMoveTimestampIndex(
      [
        {
          t: 100,
          type: 'state-patch',
          payload: { tree: '{}', currentGlobalIndex: 5, orientation: 'white' },
        },
        // Тот же currentGlobalIndex — посещение продолжается.
        {
          t: 500,
          type: 'state-patch',
          payload: { tree: '{}', currentGlobalIndex: 5, orientation: 'white' },
        },
        { t: 2000, type: 'closed', payload: { reason: 'by_owner' } },
      ],
      2000,
    );
    const visits = index.visits.get('0:5');
    expect(visits).toBeDefined();
    expect(visits).toHaveLength(1);
    expect(visits![0]).toEqual({
      enteredAtMs: 100,
      endedAtMs: 2000,
      durationMs: 1900,
    });
  });

  it('analysis-switch НЕ синтетический (после state-patch на t=0) — закрывает сегмент', () => {
    const index = buildMoveTimestampIndex(
      [
        // На t=0 уже есть state-patch — следующий switch на t=0 НЕ
        // считается «синтетическим первым» (state.visits уже не пуст).
        {
          t: 0,
          type: 'state-patch',
          payload: { tree: '{}', currentGlobalIndex: 0, orientation: 'white' },
        },
        {
          t: 1000,
          type: 'analysis-switch',
          payload: { analysisId: 'A', title: 'A' },
        },
        { t: 5000, type: 'closed', payload: { reason: 'by_owner' } },
      ],
      5000,
    );
    expect(index.segmentBoundaries).toEqual([
      { segment: 0, startedAtMs: 0, endedAtMs: 1000, title: null },
      { segment: 1, startedAtMs: 1000, endedAtMs: 5000, title: 'A' },
    ]);
    expect(index.visits.get('0:0')).toEqual([
      { enteredAtMs: 0, endedAtMs: 1000, durationMs: 1000 },
    ]);
  });
});

describe('serializeMoveKey / parseMoveKey', () => {
  it('round-trip', () => {
    const k = { segment: 3, globalIndex: 42 };
    expect(parseMoveKey(serializeMoveKey(k))).toEqual(k);
  });

  it('канонический формат — десятичные числа через ":" без padding', () => {
    expect(serializeMoveKey({ segment: 0, globalIndex: 0 })).toBe('0:0');
    expect(serializeMoveKey({ segment: 10, globalIndex: 100 })).toBe('10:100');
  });

  it('parseMoveKey на мусоре возвращает NaN (не throw)', () => {
    expect(parseMoveKey('garbage')).toEqual({
      segment: NaN,
      globalIndex: NaN,
    });
    expect(parseMoveKey('1:abc')).toEqual({ segment: 1, globalIndex: NaN });
  });
});
