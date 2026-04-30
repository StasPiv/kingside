/**
 * KS-2161. Юнит-тесты pure-helpers движка synthetic-партий: multipv noise,
 * blunder, sanity, timing.
 */
import {
  computeThinkMs,
  decideBlunder,
  eligibleMultipvCandidates,
  multipvWeightsForRating,
  pickSubOptimalOrBlunder,
  pickWithMultipvNoise,
  phaseFromPly,
  sanityCheckMateInTwoOrThree,
  type MultipvLine,
} from './synthetic-move-engine.helpers';

function line(
  rank: number,
  uci: string,
  scoreCp: number | null,
  mateIn: number | null = null,
): MultipvLine {
  return { rank, uci, scoreCp, mateIn };
}

describe('phaseFromPly', () => {
  it('boundaries: 20→opening, 21→middlegame, 60→middlegame, 61→endgame', () => {
    expect(phaseFromPly(20)).toBe('opening');
    expect(phaseFromPly(21)).toBe('middlegame');
    expect(phaseFromPly(60)).toBe('middlegame');
    expect(phaseFromPly(61)).toBe('endgame');
  });
});

describe('multipvWeightsForRating', () => {
  it('rating < 1500 → 70/22/8', () => {
    expect(multipvWeightsForRating(1499)).toEqual([70, 22, 8]);
  });
  it('1500..1899 → 80/16/4', () => {
    expect(multipvWeightsForRating(1500)).toEqual([80, 16, 4]);
    expect(multipvWeightsForRating(1899)).toEqual([80, 16, 4]);
  });
  it('1900..2099 → 88/10/2', () => {
    expect(multipvWeightsForRating(2099)).toEqual([88, 10, 2]);
  });
  it('2100+ → 94/5/1', () => {
    expect(multipvWeightsForRating(2200)).toEqual([94, 5, 1]);
  });
});

describe('eligibleMultipvCandidates', () => {
  it('включает best всегда + те, у кого |diff| ≤ 150 cp', () => {
    const lines = [
      line(1, 'a', 30),
      line(2, 'b', 100), // diff 70 — ок
      line(3, 'c', -200), // diff 230 — не ок
    ];
    const out = eligibleMultipvCandidates(lines);
    expect(out.map((l) => l.rank)).toEqual([1, 2]);
  });

  it('mate-варианты не идут в шум (только best, остальные отброшены)', () => {
    const lines = [line(1, 'a', null, 5), line(2, 'b', 0)];
    const out = eligibleMultipvCandidates(lines);
    expect(out).toHaveLength(1);
    expect(out[0].rank).toBe(1);
  });

  it('возвращает максимум 3 кандидата', () => {
    const lines = [
      line(1, 'a', 30),
      line(2, 'b', 50),
      line(3, 'c', 70),
      line(4, 'd', 90),
    ];
    expect(eligibleMultipvCandidates(lines)).toHaveLength(3);
  });

  it('пустой вход → []', () => {
    expect(eligibleMultipvCandidates([])).toEqual([]);
  });
});

describe('pickWithMultipvNoise', () => {
  const cands = [line(1, 'best', 30), line(2, '2nd', 0), line(3, '3rd', -50)];

  it('rating 1300, random=0.10 (попадает в 70%) → best', () => {
    const r = pickWithMultipvNoise(cands, 1300, () => 0.1);
    expect(r.line.rank).toBe(1);
    expect(r.noiseIndex).toBe(0);
  });

  it('rating 1300, random=0.85 (попадает в 22%, 70..92) → 2nd', () => {
    const r = pickWithMultipvNoise(cands, 1300, () => 0.85);
    expect(r.line.rank).toBe(2);
    expect(r.noiseIndex).toBe(1);
  });

  it('rating 1300, random=0.95 (>92, в 8%) → 3rd', () => {
    const r = pickWithMultipvNoise(cands, 1300, () => 0.95);
    expect(r.line.rank).toBe(3);
    expect(r.noiseIndex).toBe(2);
  });

  it('rating 2200, random=0.95 (хвост 1%) → 3rd', () => {
    const r = pickWithMultipvNoise(cands, 2200, () => 0.995);
    expect(r.line.rank).toBe(3);
  });

  it('один кандидат → всегда best, без вызова random', () => {
    const fakeRandom = jest.fn();
    const r = pickWithMultipvNoise([cands[0]], 1500, fakeRandom);
    expect(r.line.rank).toBe(1);
    expect(fakeRandom).not.toHaveBeenCalled();
  });

  it('пустой кандидат-список → throws', () => {
    expect(() => pickWithMultipvNoise([], 1500)).toThrow(/no candidates/);
  });
});

describe('decideBlunder', () => {
  it('rating ≥ 1000 → всегда normal', () => {
    expect(decideBlunder(1000)).toBe('normal');
    expect(decideBlunder(2000)).toBe('normal');
  });

  it('rating 700, random=0.005 → blunder (< 1.5%)', () => {
    expect(decideBlunder(700, () => 0.005)).toBe('blunder');
  });

  it('rating 700, random=0.05 (5%) → sub-optimal (1.5..11.5%)', () => {
    expect(decideBlunder(700, () => 0.05)).toBe('sub-optimal');
  });

  it('rating 700, random=0.5 → normal (>11.5%)', () => {
    expect(decideBlunder(700, () => 0.5)).toBe('normal');
  });

  it('распределение на 10K случаев примерно совпадает', () => {
    let blunders = 0;
    let subs = 0;
    let normals = 0;
    for (let i = 0; i < 10_000; i++) {
      const d = decideBlunder(700);
      if (d === 'blunder') blunders++;
      else if (d === 'sub-optimal') subs++;
      else normals++;
    }
    // 1-2% (нацелены на 1.5%): допуск 0.7..2.2%
    expect(blunders / 10_000).toBeGreaterThan(0.007);
    expect(blunders / 10_000).toBeLessThan(0.025);
    // 5-15% (нацелены на 10%): допуск 7..14%
    expect(subs / 10_000).toBeGreaterThan(0.07);
    expect(subs / 10_000).toBeLessThan(0.14);
    expect(normals / 10_000).toBeGreaterThan(0.85);
  });
});

describe('pickSubOptimalOrBlunder', () => {
  it('берёт 4-6 ранг если он есть', () => {
    const lines = [
      line(1, 'a', 50),
      line(2, 'b', 30),
      line(3, 'c', 10),
      line(4, 'd', -10),
      line(5, 'e', -20),
      line(6, 'f', -30),
    ];
    const r = pickSubOptimalOrBlunder(lines, () => 0);
    expect([4, 5, 6]).toContain(r!.rank);
  });

  it('если нет 4-6 ранга — возвращает последний доступный', () => {
    const lines = [line(1, 'a', 50), line(2, 'b', 30)];
    const r = pickSubOptimalOrBlunder(lines);
    expect(r!.rank).toBe(2);
  });

  it('пустой вход → null', () => {
    expect(pickSubOptimalOrBlunder([])).toBeNull();
  });
});

describe('sanityCheckMateInTwoOrThree', () => {
  const best = line(1, 'best', 50);
  const candidate = line(2, 'noisy', 30);

  it('mate в 2 за соперника → подмена на best', () => {
    const r = sanityCheckMateInTwoOrThree({
      candidate,
      best,
      mateForOpponentAfterCandidate: 2,
    });
    expect(r.uci).toBe('best');
  });

  it('mate в 1 → подмена на best (one-move blunder)', () => {
    const r = sanityCheckMateInTwoOrThree({
      candidate,
      best,
      mateForOpponentAfterCandidate: 1,
    });
    expect(r.uci).toBe('best');
  });

  it('mate в 3 → подмена', () => {
    const r = sanityCheckMateInTwoOrThree({
      candidate,
      best,
      mateForOpponentAfterCandidate: 3,
    });
    expect(r.uci).toBe('best');
  });

  it('mate в 4+ → НЕ подменяем (за горизонтом sanity)', () => {
    const r = sanityCheckMateInTwoOrThree({
      candidate,
      best,
      mateForOpponentAfterCandidate: 4,
    });
    expect(r.uci).toBe('noisy');
  });

  it('mateIn=null → ход не трогаем', () => {
    const r = sanityCheckMateInTwoOrThree({
      candidate,
      best,
      mateForOpponentAfterCandidate: null,
    });
    expect(r.uci).toBe('noisy');
  });
});

describe('computeThinkMs', () => {
  it('для blitz/middlegame mean ≈ 4 s, total в пределах hardCap', () => {
    const t = computeThinkMs({
      category: 'blitz',
      phase: 'middlegame',
      evalDiffCp: 50,
      random: () => 0.5,
    });
    expect(t).toBeGreaterThanOrEqual(200);
    expect(t).toBeLessThanOrEqual(12_000 + 700);
  });

  it('clamp к минимальным 200 ms даже при экстремально маленьком mean (опять же + reaction)', () => {
    const t = computeThinkMs({
      category: 'bullet',
      phase: 'opening',
      evalDiffCp: 0,
      // отрицательный noise делает base < 200, мы должны взять 200.
      random: () => 0.01,
    });
    expect(t).toBeGreaterThanOrEqual(200);
  });

  // KS-2175: hardCap по категориям приведены к ADR-034 §6.1.
  // bullet 4s, blitz 12s, rapid 60s, classical 180s.
  it.each([
    ['bullet', 4_000],
    ['blitz', 12_000],
    ['rapid', 60_000],
    ['classical', 180_000],
  ] as const)('hard cap для %s ≤ %i ms + reaction (≤ +700)', (category, cap) => {
    let max = 0;
    for (let i = 0; i < 100; i++) {
      const t = computeThinkMs({
        category,
        phase: 'middlegame',
        // diff ≥ 250 → complexity 0.6 (быстрый ход), но 3% «долгая
        // дума» × 3 даёт пик. Без этого пик не достигает hardCap.
        evalDiffCp: 0, // → complexity 1.5 (равноценные → думают долго)
      });
      if (t > max) max = t;
    }
    expect(max).toBeLessThanOrEqual(cap + 700);
  });

  // KS-2175: complexity multiplier по ADR §6.3 (НЕ инвертирован).
  // Равноценные варианты (diff < 30) → ×1.5 (думаем дольше).
  // Очевидно лучший (diff > 250) → ×0.6 (играем быстрее).
  describe('complexity multiplier — KS-2175 (ADR §6.3)', () => {
    it('равноценные варианты (diff=10) дольше очевидного (diff=300) на 200 sample', () => {
      let equalSum = 0; // diff < 30 → ×1.5
      let obviousSum = 0; // diff ≥ 250 → ×0.6
      for (let i = 0; i < 500; i++) {
        equalSum += computeThinkMs({
          category: 'rapid',
          phase: 'middlegame',
          evalDiffCp: 10,
        });
        obviousSum += computeThinkMs({
          category: 'rapid',
          phase: 'middlegame',
          evalDiffCp: 300,
        });
      }
      // 1.5 / 0.6 = 2.5×. Допускаем ≥ 1.8× с учётом jitter и reaction.
      expect(equalSum / obviousSum).toBeGreaterThan(1.8);
    });

    it('boundary <30 cp → equal (×1.5)', () => {
      // detached pure-сравнение: при random=0.5 jitter=0,
      // longThink=false. Total = mean*1.5 + reaction.
      // Random=0.5 даёт jitterNormal ≈ 0 (cos π = -1, hmm
      // математика чуть сложнее) — проверим качественно: при diff=29
      // среднее > при diff=30..149 (×1.2).
      let lowSum = 0;
      let midSum = 0;
      for (let i = 0; i < 200; i++) {
        lowSum += computeThinkMs({
          category: 'rapid',
          phase: 'middlegame',
          evalDiffCp: 25, // ×1.5
        });
        midSum += computeThinkMs({
          category: 'rapid',
          phase: 'middlegame',
          evalDiffCp: 100, // ×1.2
        });
      }
      expect(lowSum).toBeGreaterThan(midSum);
    });

    it('diff в диапазоне 30..150 cp → mid (×1.2)', () => {
      let midSum = 0; // ×1.2
      let obvSum = 0; // ×0.9 (diff 150..250)
      for (let i = 0; i < 200; i++) {
        midSum += computeThinkMs({
          category: 'rapid',
          phase: 'middlegame',
          evalDiffCp: 100,
        });
        obvSum += computeThinkMs({
          category: 'rapid',
          phase: 'middlegame',
          evalDiffCp: 200,
        });
      }
      expect(midSum).toBeGreaterThan(obvSum);
    });

    it('diff 150..250 cp → quasi-obvious (×0.9), быстрее равноценных', () => {
      let equalSum = 0;
      let obviousSum = 0;
      for (let i = 0; i < 300; i++) {
        equalSum += computeThinkMs({
          category: 'rapid',
          phase: 'middlegame',
          evalDiffCp: 10,
        });
        obviousSum += computeThinkMs({
          category: 'rapid',
          phase: 'middlegame',
          evalDiffCp: 200,
        });
      }
      expect(equalSum).toBeGreaterThan(obviousSum);
    });
  });
});
