/**
 * KS-2163. Тесты pure-helpers bootstrap'а.
 */
import {
  computeBootstrapProgress,
  parseTcDistribution,
  pickTcCategory,
  selectBootstrapPair,
  DEFAULT_BOOTSTRAP_TC_DISTRIBUTION,
  PAIR_MAX_REPEAT_PARTNER,
  PAIR_RATING_BAND,
  type SyntheticCandidate,
} from './bootstrap-helpers';

function cand(
  userId: string,
  rating: number,
  gamesPlayed = 0,
  partnerCounts: Record<string, number> = {},
): SyntheticCandidate {
  return {
    userId,
    rating,
    gamesPlayed,
    partnerCounts: new Map(Object.entries(partnerCounts)),
  };
}

describe('selectBootstrapPair', () => {
  it('возвращает null при <2 кандидатов', () => {
    expect(selectBootstrapPair([])).toBeNull();
    expect(selectBootstrapPair([cand('a', 1500)])).toBeNull();
  });

  it('подбирает наименее загруженного и совместимого по rating ±150', () => {
    const c = [
      cand('a', 1500, 0),
      cand('b', 1490, 5),
      cand('c', 1700, 0), // вне диапазона ±150
    ];
    const pair = selectBootstrapPair(c, () => 0);
    expect(pair).not.toBeNull();
    // 'a' имеет минимум gamesPlayed → он один из участников.
    expect([pair!.white.userId, pair!.black.userId]).toContain('a');
    expect([pair!.white.userId, pair!.black.userId]).toContain('b');
  });

  it('пропускает партнёра, с которым уже играли 3+ раза', () => {
    const c = [
      cand('a', 1500, 0, { b: 3 }), // 'b' исчерпан
      cand('b', 1490, 0),
      cand('c', 1480, 5),
    ];
    const pair = selectBootstrapPair(c, () => 0);
    expect(pair).not.toBeNull();
    // Должны взять 'c', не 'b'.
    expect([pair!.white.userId, pair!.black.userId]).toContain('c');
    expect([pair!.white.userId, pair!.black.userId]).not.toContain('b');
  });

  it('null если у наименее загруженного нет совместимых партнёров', () => {
    const c = [
      cand('a', 1500, 0),
      cand('b', 2000, 0), // вне диапазона
    ];
    expect(selectBootstrapPair(c)).toBeNull();
  });

  it('случайный цвет: на 100 итерациях обе стороны примерно равные', () => {
    const c = [cand('a', 1500), cand('b', 1500)];
    let aWhite = 0;
    for (let i = 0; i < 1000; i++) {
      const p = selectBootstrapPair(c)!;
      if (p.white.userId === 'a') aWhite++;
    }
    expect(aWhite).toBeGreaterThan(400);
    expect(aWhite).toBeLessThan(600);
  });

  it('PAIR_RATING_BAND и PAIR_MAX_REPEAT_PARTNER экспортируются', () => {
    expect(PAIR_RATING_BAND).toBe(150);
    expect(PAIR_MAX_REPEAT_PARTNER).toBe(3);
  });
});

describe('pickTcCategory + parseTcDistribution', () => {
  it('default распределение: bullet/blitz/rapid ≈ 30% каждый, classical ≈ 10%', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) {
      const c = pickTcCategory(DEFAULT_BOOTSTRAP_TC_DISTRIBUTION);
      counts[c] = (counts[c] ?? 0) + 1;
    }
    expect(counts['bullet']).toBeGreaterThan(2500);
    expect(counts['bullet']).toBeLessThan(3500);
    expect(counts['blitz']).toBeGreaterThan(2500);
    expect(counts['blitz']).toBeLessThan(3500);
    expect(counts['rapid']).toBeGreaterThan(2500);
    expect(counts['rapid']).toBeLessThan(3500);
    expect(counts['classical']).toBeGreaterThan(700);
    expect(counts['classical']).toBeLessThan(1300);
  });

  it('parseTcDistribution: env-формат нормально парсится', () => {
    const dist = parseTcDistribution('bullet=0.5,blitz=0.3,rapid=0.15,classical=0.05');
    expect(dist).toHaveLength(4);
    expect(dist[0]).toEqual({ category: 'bullet', weight: 50 });
    expect(dist[3]).toEqual({ category: 'classical', weight: 5 });
  });

  it('parseTcDistribution: пустой/мусорный → default', () => {
    expect(parseTcDistribution(undefined)).toBe(DEFAULT_BOOTSTRAP_TC_DISTRIBUTION);
    expect(parseTcDistribution('')).toBe(DEFAULT_BOOTSTRAP_TC_DISTRIBUTION);
    expect(parseTcDistribution('lol=0.5')).toBe(DEFAULT_BOOTSTRAP_TC_DISTRIBUTION);
  });
});

describe('computeBootstrapProgress', () => {
  it('пустой пул → done=false (totalSynthetics=0)', () => {
    const r = computeBootstrapProgress(new Map(), 30, 100);
    expect(r.done).toBe(false);
    expect(r.completed).toBe(0);
  });

  it('все ≥ target → done=true', () => {
    const counts = new Map([
      ['a', 30],
      ['b', 35],
      ['c', 30],
    ]);
    const r = computeBootstrapProgress(counts, 30, 50);
    expect(r.done).toBe(true);
    expect(r.completed).toBe(3);
    expect(r.totalSynthetics).toBe(3);
    expect(r.gamesRemainingTotal).toBe(0);
  });

  it('частичный прогресс: ETA рассчитан по rate', () => {
    const counts = new Map([
      ['a', 10],
      ['b', 15],
    ]);
    // Осталось: (30-10) + (30-15) = 35 партий, при 5/час = 7 часов.
    const r = computeBootstrapProgress(counts, 30, 5);
    expect(r.gamesRemainingTotal).toBe(35);
    expect(r.etaHours).toBe(7);
    expect(r.done).toBe(false);
  });

  it('rate=null → etaHours=null', () => {
    const counts = new Map([['a', 0]]);
    const r = computeBootstrapProgress(counts, 30, null);
    expect(r.etaHours).toBeNull();
  });

  it('gamesPlayedTotal — сумма по всем', () => {
    const counts = new Map([
      ['a', 5],
      ['b', 10],
      ['c', 15],
    ]);
    const r = computeBootstrapProgress(counts, 30, null);
    expect(r.gamesPlayedTotal).toBe(30);
  });
});
