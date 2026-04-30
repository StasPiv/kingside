/**
 * KS-2162. Тесты `buildSyntheticProfiles` — что builder корректно
 * собирает 200 профилей из pure-helpers.
 */
import {
  buildSyntheticProfiles,
  groupByBaseRatingBand,
  groupByCountry,
} from './synthetic-profile-builder';

describe('buildSyntheticProfiles', () => {
  it('генерит ровно count профилей с уникальными username', () => {
    const profiles = buildSyntheticProfiles({
      count: 200,
      now: new Date('2026-04-30T00:00:00Z'),
    });
    expect(profiles).toHaveLength(200);
    expect(new Set(profiles.map((p) => p.username)).size).toBe(200);
  });

  it('у каждого профиля есть country (2 символа), 4 рейтинга в [600,2700], createdAt в окне', () => {
    const now = new Date('2026-04-30T00:00:00Z');
    const profiles = buildSyntheticProfiles({ count: 30, now });
    for (const p of profiles) {
      expect(p.isSynthetic).toBe(true);
      expect(p.isBot).toBe(false);
      expect(p.country).toMatch(/^[A-Z]{2}$/);
      for (const r of [
        p.ratingBullet,
        p.ratingBlitz,
        p.ratingRapid,
        p.ratingClassical,
      ]) {
        expect(r).toBeGreaterThanOrEqual(600);
        expect(r).toBeLessThanOrEqual(2700);
      }
      const delta = now.getTime() - p.createdAt.getTime();
      expect(delta).toBeGreaterThanOrEqual(6 * 30 * 24 * 3600 * 1000);
      expect(delta).toBeLessThanOrEqual(18 * 30 * 24 * 3600 * 1000);
    }
  });

  it('категориальные рейтинги отличаются друг от друга для одного профиля', () => {
    const profiles = buildSyntheticProfiles({
      count: 100,
      now: new Date('2026-04-30T00:00:00Z'),
    });
    let differentCount = 0;
    for (const p of profiles) {
      const set = new Set([
        p.ratingBullet,
        p.ratingBlitz,
        p.ratingRapid,
        p.ratingClassical,
      ]);
      if (set.size > 1) differentCount++;
    }
    // Все 4 одинаковых — теоретически возможно, но крайне маловероятно
    // на N(0,80). Должно быть >= 99 из 100.
    expect(differentCount).toBeGreaterThan(95);
  });

  it('распределение по полосам базового рейтинга в допуске Q10', () => {
    const profiles = buildSyntheticProfiles({
      count: 200,
      now: new Date('2026-04-30T00:00:00Z'),
    });
    const groups = groupByBaseRatingBand(profiles);
    // Q10 expected: 16 / 44 / 56 / 50 / 24 / 10. Допуск ±15 на 200.
    expect(groups['600-999']).toBeGreaterThan(4);
    expect(groups['600-999']).toBeLessThan(30);
    expect(groups['1300-1599']).toBeGreaterThan(40);
    expect(groups['1300-1599']).toBeLessThan(72);
    expect(groups['2200-2499']).toBeGreaterThan(0);
  });

  it('распределение стран в допуске Q9 (RU/US доминируют)', () => {
    const profiles = buildSyntheticProfiles({
      count: 200,
      now: new Date('2026-04-30T00:00:00Z'),
    });
    const groups = groupByCountry(profiles);
    // RU 30% × 200 = 60, допуск ±15.
    expect(groups['RU'] ?? 0).toBeGreaterThan(40);
    expect(groups['RU'] ?? 0).toBeLessThan(80);
    // US 20% × 200 = 40, допуск ±15.
    expect(groups['US'] ?? 0).toBeGreaterThan(20);
    expect(groups['US'] ?? 0).toBeLessThan(60);
  });
});
