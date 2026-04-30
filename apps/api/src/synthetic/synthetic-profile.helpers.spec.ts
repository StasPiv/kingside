/**
 * KS-2162. Тесты pure-helpers генерации synthetic-профилей.
 */
import {
  COUNTRY_WEIGHTS,
  COUNTRY_TOTAL_WEIGHT,
  RATING_BAND_WEIGHTS,
  dicebearAvatarUrl,
  generateUniqueUsernames,
  generateUsername,
  sampleBaseRating,
  sampleCategoryRating,
  sampleCountry,
  sampleCreatedAt,
  weightedPickIndex,
} from './synthetic-profile.helpers';

describe('weightedPickIndex', () => {
  it('детерминирован при подменяемом rng', () => {
    expect(weightedPickIndex([10, 30, 60], () => 0.0)).toBe(0);
    expect(weightedPickIndex([10, 30, 60], () => 0.5)).toBe(2);
    expect(weightedPickIndex([10, 30, 60], () => 0.99)).toBe(2);
  });
  it('распределение на 10К ≈ ожидаемому', () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 10_000; i++) {
      counts[weightedPickIndex([10, 30, 60])]++;
    }
    expect(counts[0]).toBeGreaterThan(800);
    expect(counts[0]).toBeLessThan(1200);
    expect(counts[2]).toBeGreaterThan(5500);
    expect(counts[2]).toBeLessThan(6500);
  });
  it('пустой массив весов → 0', () => {
    expect(weightedPickIndex([], () => 0.5)).toBe(0);
  });
});

describe('COUNTRY_WEIGHTS — Q9 distribution', () => {
  it('сумма = 100 (нормированное распределение)', () => {
    expect(COUNTRY_TOTAL_WEIGHT).toBe(100);
  });
  it('топ-4 веса по ADR §2.2: RU 30, US 20, IN 10, BR 8', () => {
    const map = new Map(COUNTRY_WEIGHTS.map((c) => [c.code, c.weight]));
    expect(map.get('RU')).toBe(30);
    expect(map.get('US')).toBe(20);
    expect(map.get('IN')).toBe(10);
    expect(map.get('BR')).toBe(8);
  });
});

describe('sampleCountry — distribution на 200 sample', () => {
  it('RU ≈ 60, US ≈ 40, BR ≈ 16, прочие сумма ≈ 64 (±15 на 200)', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      const c = sampleCountry();
      counts[c] = (counts[c] ?? 0) + 1;
    }
    expect(counts['RU'] ?? 0).toBeGreaterThan(45);
    expect(counts['RU'] ?? 0).toBeLessThan(75);
    expect(counts['US'] ?? 0).toBeGreaterThan(25);
    expect(counts['US'] ?? 0).toBeLessThan(55);
    // Сумма "не топ-4" — около 32% × 200 = 64 (±20).
    const top4 = (counts.RU ?? 0) + (counts.US ?? 0) + (counts.IN ?? 0) + (counts.BR ?? 0);
    const others = 200 - top4;
    expect(others).toBeGreaterThan(40);
    expect(others).toBeLessThan(85);
  });
});

describe('RATING_BAND_WEIGHTS — Q10 distribution', () => {
  it('сумма = 100', () => {
    expect(RATING_BAND_WEIGHTS.reduce((s, b) => s + b.weight, 0)).toBe(100);
  });
});

describe('sampleBaseRating', () => {
  it('всегда в [600, 2499]', () => {
    for (let i = 0; i < 1000; i++) {
      const r = sampleBaseRating();
      expect(r).toBeGreaterThanOrEqual(600);
      expect(r).toBeLessThanOrEqual(2499);
    }
  });
  it('пик в 1300–1599 на 200 sample (Q10: 28%)', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      const r = sampleBaseRating();
      const band = RATING_BAND_WEIGHTS.find(
        (b) => r >= b.min && r <= b.max,
      );
      const k = `${band!.min}-${band!.max}`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    // 28% × 200 = 56, допуск ±20.
    expect(counts['1300-1599']).toBeGreaterThan(36);
    expect(counts['1300-1599']).toBeLessThan(76);
  });
});

describe('sampleCategoryRating', () => {
  it('clamp в [600, 2700]', () => {
    for (let i = 0; i < 100; i++) {
      const r = sampleCategoryRating(2500);
      expect(r).toBeLessThanOrEqual(2700);
    }
    for (let i = 0; i < 100; i++) {
      const r = sampleCategoryRating(700);
      expect(r).toBeGreaterThanOrEqual(600);
    }
  });
  it('mean ≈ base на 1000 экспериментов', () => {
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += sampleCategoryRating(1500);
    const mean = sum / 1000;
    expect(Math.abs(mean - 1500)).toBeLessThan(20);
  });
});

describe('sampleCreatedAt', () => {
  it('дата в окне [now − 18mo, now − 6mo]', () => {
    const now = new Date('2026-04-30T00:00:00Z');
    const sixMo = 6 * 30 * 24 * 3600 * 1000;
    const eighteenMo = 18 * 30 * 24 * 3600 * 1000;
    for (let i = 0; i < 100; i++) {
      const d = sampleCreatedAt(now);
      const delta = now.getTime() - d.getTime();
      expect(delta).toBeGreaterThanOrEqual(sixMo);
      expect(delta).toBeLessThanOrEqual(eighteenMo);
    }
  });
});

describe('generateUsername', () => {
  it('en: format {Adj}{Noun}{NN}', () => {
    // rng=0.5 даёт en-вариант (15% < 0.5 не попадает).
    let cnt = 0;
    for (let i = 0; i < 100; i++) {
      const u = generateUsername(() => 0.5);
      if (/^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/.test(u)) cnt++;
    }
    expect(cnt).toBe(100);
  });

  it('ru: format {Прил}{Сущ}_NNNN', () => {
    // rng=0 → isRu=true (0 < 0.15).
    const u = generateUsername(() => 0);
    expect(/^[А-ЯЁ][а-яё]+[А-ЯЁ][а-яё]+_\d{4}$/.test(u)).toBe(true);
  });

  it('15% русских (±5% на 1000 sample)', () => {
    let ru = 0;
    for (let i = 0; i < 1000; i++) {
      const u = generateUsername();
      if (/_\d{4}$/.test(u)) ru++;
    }
    expect(ru).toBeGreaterThan(100);
    expect(ru).toBeLessThan(200);
  });
});

describe('generateUniqueUsernames', () => {
  it('200 уникальных без коллизий', () => {
    const names = generateUniqueUsernames(200);
    expect(names).toHaveLength(200);
    expect(new Set(names).size).toBe(200);
  });
  it('1000 уникальных тоже работает', () => {
    const names = generateUniqueUsernames(1000);
    expect(new Set(names).size).toBe(1000);
  });
});

describe('dicebearAvatarUrl', () => {
  it('возвращает URL с PNG-форматом и encoded seed', () => {
    expect(dicebearAvatarUrl('Конь42')).toBe(
      'https://api.dicebear.com/8.x/avataaars/png?seed=%D0%9A%D0%BE%D0%BD%D1%8C42',
    );
  });
  it('кастомный style', () => {
    expect(dicebearAvatarUrl('Foo', 'bottts')).toBe(
      'https://api.dicebear.com/8.x/bottts/png?seed=Foo',
    );
  });
});
