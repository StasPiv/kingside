/**
 * KS-3603. Тесты `buildAnnotation` — все правила §3.2 (NAG-таблица),
 * §3.3 (suppress), §4.1 (green-variation), §4.2 (red-variation), §3.4
 * (mate ↔ cp). Полное покрытие по acceptance.
 */
import { describe, it, expect } from 'vitest';

import {
  NAG_BLUNDER,
  NAG_MISTAKE,
  NAG_DUBIOUS,
  NAG_INTERESTING,
  NAG_GOOD,
  NAG_BRILLIANT,
  buildAnnotation,
  buildAnnotations,
  mateToCp,
  type MoveInput,
} from './buildAnnotations';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function base(over: Partial<MoveInput> = {}): MoveInput {
  return {
    ply: 1,
    fen: STARTPOS,
    playedUci: 'e2e4',
    sfBestUci: 'e2e4',
    cpBefore: 40,
    cpBest: 40,
    cpPlayed: 40,
    secondBestCp: 30,
    sfBestPv: ['e2e4', 'e7e5', 'g1f3'],
    playedProb: 0.3,
    sfBestProb: 0.3,
    maiaTopUci: 'e2e4',
    maiaTopProb: 0.3,
    maiaTopCpLoss: 0,
    forcedMove: false,
    mateBefore: null,
    ...over,
  };
}

describe('mateToCp (§3.4)', () => {
  it('положительный мат: +N → +10000 - N', () => {
    expect(mateToCp(2)).toBe(9998);
    expect(mateToCp(1)).toBe(9999);
  });
  it('отрицательный мат: -N → -10000 + N (т.е. -10000 - (-N))', () => {
    expect(mateToCp(-2)).toBe(-9998);
    expect(mateToCp(-1)).toBe(-9999);
  });
  it('clamp ±10000', () => {
    expect(mateToCp(20)).toBe(9980);
    expect(mateToCp(-20)).toBe(-9980);
    expect(mateToCp(0)).toBe(0);
  });
});

describe('buildAnnotation — §3.2 таблица NAG', () => {
  it('?? при cpLoss ≥ 200', () => {
    const a = buildAnnotation(
      base({ playedUci: 'e2e3', sfBestUci: 'e2e4', cpBest: 40, cpPlayed: -160 }),
    );
    // cpLoss = 40 - (-160) = 200 → ровно порог.
    expect(a.nag).toEqual([NAG_BLUNDER]);
  });
  it('?? при cpLoss > 200', () => {
    const a = buildAnnotation(
      base({ playedUci: 'e2e3', sfBestUci: 'e2e4', cpBest: 40, cpPlayed: -300 }),
    );
    expect(a.nag).toEqual([NAG_BLUNDER]);
  });
  it('? при 100 ≤ cpLoss < 200', () => {
    const a = buildAnnotation(
      base({ playedUci: 'e2e3', sfBestUci: 'e2e4', cpBest: 40, cpPlayed: -60 }),
    );
    // cpLoss = 100 ровно.
    expect(a.nag).toEqual([NAG_MISTAKE]);

    const b = buildAnnotation(
      base({ playedUci: 'e2e3', sfBestUci: 'e2e4', cpBest: 40, cpPlayed: -150 }),
    );
    expect(b.nag).toEqual([NAG_MISTAKE]);
  });
  it('?! при 50 ≤ cpLoss < 100 И played ≠ best', () => {
    const a = buildAnnotation(
      base({ playedUci: 'e2e3', sfBestUci: 'e2e4', cpBest: 40, cpPlayed: -10 }),
    );
    // cpLoss = 50 ровно.
    expect(a.nag).toEqual([NAG_DUBIOUS]);
  });
  it('?! НЕ применяется если played = best (но cpLoss = 0 в таком случае)', () => {
    const a = buildAnnotation(base({ cpBest: 60, cpPlayed: 60, playedProb: 0.5 }));
    expect(a.nag).not.toEqual([NAG_DUBIOUS]);
  });
  it('!? при cpLoss < 50 И played ≠ best И playedProb ≥ 0.30', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'g1f3',
        sfBestUci: 'e2e4',
        cpBest: 40,
        cpPlayed: 20, // cpLoss=20
        playedProb: 0.35,
      }),
    );
    expect(a.nag).toEqual([NAG_INTERESTING]);
  });
  it('!? НЕ применяется при playedProb < 0.30', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'g1f3',
        sfBestUci: 'e2e4',
        cpBest: 40,
        cpPlayed: 20,
        playedProb: 0.29,
      }),
    );
    expect(a.nag).toEqual([]);
  });
  it('! при played=best И playedProb<0.20 И cpLoss=0', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        cpBest: 40,
        cpPlayed: 40,
        playedProb: 0.15,
        secondBestCp: 30, // gap=10, не достаточно для !!
      }),
    );
    expect(a.nag).toEqual([NAG_GOOD]);
  });
  it('! НЕ применяется при playedProb ≥ 0.20', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        cpBest: 40,
        cpPlayed: 40,
        playedProb: 0.21,
      }),
    );
    expect(a.nag).toEqual([]);
  });
  it('!! при played=best, playedProb<0.05, cpLoss=0, НЕ forced, gap≥150', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        cpBefore: 200,
        cpBest: 200,
        cpPlayed: 200,
        secondBestCp: 40, // gap=160 ≥ 150
        playedProb: 0.04,
        forcedMove: false,
      }),
    );
    expect(a.nag).toEqual([NAG_BRILLIANT]);
  });
  it('!! НЕ применяется если gap < 150', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        cpBefore: 200,
        cpBest: 200,
        cpPlayed: 200,
        secondBestCp: 100, // gap=100 < 150
        playedProb: 0.04,
      }),
    );
    // Падает к ! (playedProb<0.20 → 1)
    expect(a.nag).toEqual([NAG_GOOD]);
  });
});

describe('buildAnnotation — §3.3 suppress', () => {
  it('forced moves → no NAG', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e3',
        sfBestUci: 'e2e4',
        cpBest: 40,
        cpPlayed: -500, // cpLoss=540
        forcedMove: true,
      }),
    );
    expect(a.nag).toEqual([]);
  });
  it('|cpBefore| > 800 → no quality-NAG (даже при большом cpLoss)', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e3',
        sfBestUci: 'e2e4',
        cpBefore: 900,
        cpBest: 900,
        cpPlayed: 600, // cpLoss=300, но позиция всё ещё выиграна
      }),
    );
    expect(a.nag).toEqual([]);
  });
  it('|cpBefore| > 800 негативно (проигран) — тоже suppress', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e3',
        sfBestUci: 'e2e4',
        cpBefore: -900,
        cpBest: -900,
        cpPlayed: -1200, // cpLoss=300
      }),
    );
    expect(a.nag).toEqual([]);
  });
  it('cpBefore = ±800 (граница) — NAG применяется', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e3',
        sfBestUci: 'e2e4',
        cpBefore: 800,
        cpBest: 800,
        cpPlayed: 500, // cpLoss=300
      }),
    );
    expect(a.nag).toEqual([NAG_BLUNDER]);
  });
  it('mate-line с сыгранным верным продолжением — cpLoss=0 → no NAG (через путь !!)', () => {
    // Мат за stm: cpBefore=mateToCp(+2)=9998, играем best → cpLoss=0.
    // !! не сработает (playedProb может быть высоким), ! — может.
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        cpBefore: 9998,
        cpBest: 9998,
        cpPlayed: 9998,
        playedProb: 0.5,
      }),
    );
    // cpBefore > 800 → suppress всех NAG.
    expect(a.nag).toEqual([]);
  });
});

describe('buildAnnotation — §4.1 green-variation', () => {
  it('добавляется на ?? (cpLoss≥200) и played≠best', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e3',
        sfBestUci: 'e2e4',
        cpBest: 40,
        cpPlayed: -200, // cpLoss=240
        sfBestPv: ['e2e4', 'e7e5', 'g1f3'],
      }),
    );
    expect(a.nag).toEqual([NAG_BLUNDER]);
    expect(a.variations).toHaveLength(1);
    expect(a.variations[0]).toMatchObject({
      uci: 'e2e4',
      color: 'green',
      subline: ['e7e5', 'g1f3'],
    });
  });
  it('добавляется на ? (cpLoss≥100, <200) и played≠best', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e3',
        sfBestUci: 'e2e4',
        cpBest: 40,
        cpPlayed: -80,
        sfBestPv: ['e2e4', 'e7e5'],
      }),
    );
    expect(a.nag).toEqual([NAG_MISTAKE]);
    expect(a.variations[0]).toMatchObject({
      uci: 'e2e4',
      color: 'green',
      subline: ['e7e5'],
    });
  });
  it('НЕ добавляется на ?! / !? / ! / !!', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'g1f3',
        sfBestUci: 'e2e4',
        cpBest: 40,
        cpPlayed: -10, // cpLoss=50 → ?!
      }),
    );
    expect(a.nag).toEqual([NAG_DUBIOUS]);
    expect(a.variations.filter((v) => v.color === 'green')).toHaveLength(0);
  });
  it('НЕ добавляется если sfBest = played', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        cpBest: 40,
        cpPlayed: -200, // невозможно по логике но проверим
      }),
    );
    expect(a.variations.filter((v) => v.color === 'green')).toHaveLength(0);
  });
});

describe('buildAnnotation — §4.2 red-variation (Maia-trap)', () => {
  it('добавляется когда maiaTop≠sfBest, prob≥0.25, cpLoss≥100, played≠maiaTop', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        cpBest: 40,
        cpPlayed: 40,
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.3,
        maiaTopCpLoss: 150, // → ? на этот ход
      }),
    );
    expect(a.variations.filter((v) => v.color === 'red')).toHaveLength(1);
    const red = a.variations.find((v) => v.color === 'red')!;
    expect(red.uci).toBe('g1f3');
    expect(red.nag).toEqual([NAG_MISTAKE]);
  });
  it('NAG ?? при maiaTopCpLoss ≥ 200', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        maiaTopUci: 'h2h3',
        maiaTopProb: 0.3,
        maiaTopCpLoss: 250,
      }),
    );
    const red = a.variations.find((v) => v.color === 'red')!;
    expect(red.nag).toEqual([NAG_BLUNDER]);
  });
  it('НЕ добавляется если maiaTopProb < 0.25', () => {
    const a = buildAnnotation(
      base({
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.24,
        maiaTopCpLoss: 200,
      }),
    );
    expect(a.variations.filter((v) => v.color === 'red')).toHaveLength(0);
  });
  it('НЕ добавляется если maiaTopCpLoss < 100', () => {
    const a = buildAnnotation(
      base({
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.3,
        maiaTopCpLoss: 99,
      }),
    );
    expect(a.variations.filter((v) => v.color === 'red')).toHaveLength(0);
  });
  it('НЕ добавляется если played = maiaTop (мы уже его сыграли)', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'g1f3',
        sfBestUci: 'e2e4',
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.3,
        maiaTopCpLoss: 200,
        cpBest: 40,
        cpPlayed: -200,
      }),
    );
    expect(a.variations.filter((v) => v.color === 'red')).toHaveLength(0);
  });
  it('НЕ добавляется если maiaTop = sfBest', () => {
    const a = buildAnnotation(
      base({
        maiaTopUci: 'e2e4',
        sfBestUci: 'e2e4',
        maiaTopProb: 0.5,
        maiaTopCpLoss: 200,
      }),
    );
    expect(a.variations.filter((v) => v.color === 'red')).toHaveLength(0);
  });
});

describe('buildAnnotation — §4.3 лимит «не более 2 variations»', () => {
  it('green + red одновременно, обе попали — ровно 2', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e3',
        sfBestUci: 'e2e4',
        cpBest: 40,
        cpPlayed: -100, // ?
        sfBestPv: ['e2e4', 'e7e5', 'g1f3'],
        maiaTopUci: 'h2h3',
        maiaTopProb: 0.3,
        maiaTopCpLoss: 200,
      }),
    );
    expect(a.variations).toHaveLength(2);
    const colors = a.variations.map((v) => v.color).sort();
    expect(colors).toEqual(['green', 'red']);
  });
});

describe('buildAnnotations — batch', () => {
  it('вернёт массив той же длины', () => {
    const out = buildAnnotations([base(), base({ ply: 2 }), base({ ply: 3 })]);
    expect(out).toHaveLength(3);
    expect(out[0].ply).toBe(1);
    expect(out[2].ply).toBe(3);
  });
});
