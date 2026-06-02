/**
 * KS-3603 → KS-3607. Тесты `buildAnnotation` через WDL/classifyMove.
 * Никаких cp-полей — только Wdl. Положительные и отрицательные кейсы
 * по таблице §3.2 ADR-100 и suppress §3.3 / variations §4.1-§4.2.
 *
 * Подбор Wdl-объектов: используем абсолютные значения которые попадают
 * в нужный loss_E-bucket по WDL_LOSS_THRESHOLDS (best ≤ 0.02, good ≤
 * 0.05, inaccuracy ≤ 0.12, mistake ≤ 0.25, blunder > 0.25). `E = (w +
 * d/2) / 1000`, поэтому loss_E = `(w_before + d_before/2 - w_after -
 * d_after/2) / 1000`. См. помощник `mkWdl(eHundredths)` ниже.
 */
import { describe, it, expect } from 'vitest';

import type { Wdl } from '@kingside/shared';

import {
  NAG_BLUNDER,
  NAG_MISTAKE,
  NAG_DUBIOUS,
  NAG_INTERESTING,
  NAG_GOOD,
  NAG_BRILLIANT,
  buildAnnotation,
  buildAnnotations,
  type MoveInput,
} from './buildAnnotations';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Сборка чистого Wdl по expected-score E (0..1).
 * E = (w + d/2) / 1000. Для теста удобно: D=0, w=E·1000, l=(1-E)·1000.
 */
function wdl(E: number): Wdl {
  const w = Math.round(E * 1000);
  return { w, d: 0, l: 1000 - w };
}

function base(over: Partial<MoveInput> = {}): MoveInput {
  return {
    ply: 1,
    fen: STARTPOS,
    playedUci: 'e2e4',
    sfBestUci: 'e2e4',
    wdlBefore: wdl(0.5),
    wdlAfterPlayed: wdl(0.5),
    wdlAfterBest: wdl(0.5),
    wdlAfterSecondBest: wdl(0.48),
    wdlAfterMaiaTop: undefined,
    sfBestPv: ['e2e4', 'e7e5', 'g1f3'],
    playedProb: 0.3,
    sfBestProb: 0.3,
    maiaTopUci: 'e2e4',
    maiaTopProb: 0.3,
    forcedMove: false,
    ...over,
  };
}

describe('buildAnnotation — §3.2 NAG по classifyMove (ADR-066)', () => {
  it('?? при loss_E > 0.25 (blunder)', () => {
    // E_before=0.5, E_after=0.2 → loss=0.30 > 0.25 → blunder.
    const a = buildAnnotation(
      base({
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.2),
      }),
    );
    expect(a.nag).toEqual([NAG_BLUNDER]);
  });

  it('?? при wdl_after.l > 950 (mate-edge)', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: { w: 10, d: 30, l: 960 },
      }),
    );
    expect(a.nag).toEqual([NAG_BLUNDER]);
  });

  it('? при 0.12 < loss_E ≤ 0.25 (mistake)', () => {
    // loss=0.20 → mistake.
    const a = buildAnnotation(
      base({
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.3),
      }),
    );
    expect(a.nag).toEqual([NAG_MISTAKE]);
  });

  it('?! при 0.05 < loss_E ≤ 0.12 (inaccuracy)', () => {
    // loss=0.10 → inaccuracy.
    const a = buildAnnotation(
      base({
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.4),
      }),
    );
    expect(a.nag).toEqual([NAG_DUBIOUS]);
  });

  it('! при playedClass=best (=sfBest) и playedProb < 0.10 (cpLoss≈0)', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.5),
        playedProb: 0.05,
      }),
    );
    expect(a.nag).toEqual([NAG_GOOD]);
  });

  it('! НЕ применяется если playedProb ≥ 0.10 (KS-3617: было 0.20)', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.5),
        playedProb: 0.15,
      }),
    );
    expect(a.nag).toEqual([]);
  });

  it('!! при played=best, playedProb<0.05, secondBestClass=mistake', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.5),
        // second-best ушёл с 0.5 в 0.3 → loss 0.20 → mistake.
        wdlAfterSecondBest: wdl(0.3),
        playedProb: 0.04,
      }),
    );
    expect(a.nag).toEqual([NAG_BRILLIANT]);
  });

  it('!! не применяется если secondBestClass = good (нет «единственного спасения»)', () => {
    // playedProb < 0.10 → откатываемся на !.
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.5),
        wdlAfterSecondBest: wdl(0.47), // loss=0.03 → good
        playedProb: 0.04,
      }),
    );
    expect(a.nag).toEqual([NAG_GOOD]);
  });

  it('!? при playedClass=good, played≠best, playedProb≥0.30', () => {
    // played≠best, loss=0.04 → good.
    const a = buildAnnotation(
      base({
        playedUci: 'g1f3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.46),
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
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.46),
        playedProb: 0.29,
      }),
    );
    expect(a.nag).toEqual([]);
  });
});

describe('buildAnnotation — §3.3 suppress', () => {
  it('forcedMove → no NAG (даже при огромном loss_E)', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.0), // blunder
        forcedMove: true,
      }),
    );
    expect(a.nag).toEqual([]);
  });

  it('KS-3617: decided до и после, одна сторона → suppress (шум в decided)', () => {
    // signed before = 0.96 (decided white), after = 0.99 (decided white).
    const a = buildAnnotation(
      base({
        wdlBefore: { w: 970, d: 20, l: 10 }, // signed=0.96
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlAfterPlayed: { w: 995, d: 0, l: 5 }, // signed=0.99
      }),
    );
    expect(a.nag).toEqual([]);
  });

  it('KS-3617: decided до, но после стало undecided → NAG ставится (упущение)', () => {
    // signed before = 0.96 (decided), after = 0.0 (ничья) — упустил выигрыш.
    const a = buildAnnotation(
      base({
        wdlBefore: { w: 970, d: 20, l: 10 }, // signed=0.96
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlAfterPlayed: wdl(0.5), // signed=0
      }),
    );
    expect(a.nag).toEqual([NAG_BLUNDER]);
  });

  it('KS-3617: decided до, перевернулось на проигрыш → NAG ставится', () => {
    // signed before = +0.96, after = -0.96 (упустили выигрыш + проиграли).
    const a = buildAnnotation(
      base({
        wdlBefore: { w: 970, d: 20, l: 10 }, // signed=+0.96
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlAfterPlayed: { w: 10, d: 20, l: 970 }, // signed=-0.96
      }),
    );
    expect(a.nag).toEqual([NAG_BLUNDER]);
  });

  it('|wdlSigned(before)| = 0.95 граница — NAG применяется', () => {
    const a = buildAnnotation(
      base({
        wdlBefore: { w: 950, d: 50, l: 0 }, // signed=0.95
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlAfterPlayed: wdl(0.2),
      }),
    );
    expect(a.nag).toEqual([NAG_BLUNDER]);
  });
});

describe('buildAnnotation — §4.1 green-variation', () => {
  it('добавляется при blunder/mistake + played≠best', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.2), // blunder
        sfBestPv: ['e2e4', 'e7e5', 'g1f3'],
      }),
    );
    expect(a.variations).toHaveLength(1);
    expect(a.variations[0]).toMatchObject({
      uci: 'e2e4',
      color: 'green',
      subline: ['e7e5', 'g1f3'],
    });
  });

  it('НЕ добавляется при inaccuracy / good / best', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'g1f3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.4), // inaccuracy
      }),
    );
    expect(a.variations.filter((v) => v.color === 'green')).toHaveLength(0);
  });

  it('НЕ добавляется если sfBest = played', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.2),
      }),
    );
    // played=sfBest → blunder ноль (classifyMove → best).
    expect(a.variations.filter((v) => v.color === 'green')).toHaveLength(0);
  });
});

describe('buildAnnotation — §4.2 red-variation', () => {
  it('добавляется когда maiaTop ≠ sfBest, prob≥0.25, class=mistake', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.5),
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.3,
        wdlAfterMaiaTop: wdl(0.3), // loss=0.20 → mistake
      }),
    );
    const red = a.variations.find((v) => v.color === 'red')!;
    expect(red).toBeTruthy();
    expect(red.uci).toBe('g1f3');
    expect(red.nag).toEqual([NAG_MISTAKE]);
  });

  it('NAG ?? при maiaTop class = blunder', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.5),
        maiaTopUci: 'h2h3',
        maiaTopProb: 0.3,
        wdlAfterMaiaTop: wdl(0.1), // blunder
      }),
    );
    const red = a.variations.find((v) => v.color === 'red')!;
    expect(red.nag).toEqual([NAG_BLUNDER]);
  });

  it('KS-3610: НЕ добавляется при maiaTopProb < 0.20', () => {
    const a = buildAnnotation(
      base({
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.19,
        wdlAfterMaiaTop: wdl(0.1),
      }),
    );
    expect(a.variations.filter((v) => v.color === 'red')).toHaveLength(0);
  });

  it('KS-3610: добавляется при maiaTopProb = 0.20 (новая граница)', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.5),
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.2,
        wdlAfterMaiaTop: wdl(0.3),
      }),
    );
    expect(a.variations.filter((v) => v.color === 'red')).toHaveLength(1);
  });

  it('KS-3610: добавляется на inaccuracy (расширение покрытия — было только mistake/blunder)', () => {
    // loss=0.10 → inaccuracy
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.5),
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.3,
        wdlAfterMaiaTop: wdl(0.4),
      }),
    );
    const red = a.variations.find((v) => v.color === 'red');
    expect(red).toBeTruthy();
    // На inaccuracy NAG не выставляем (nagForMaiaTrap → null).
    expect(red!.nag).toBeUndefined();
  });

  it('НЕ добавляется при maiaTopClass = good/best (нет ловушки)', () => {
    const a = buildAnnotation(
      base({
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.5,
        wdlAfterMaiaTop: wdl(0.49), // loss=0.01 → best
      }),
    );
    expect(a.variations.filter((v) => v.color === 'red')).toHaveLength(0);
  });

  it('skip когда wdlAfterMaiaTop undefined', () => {
    const a = buildAnnotation(
      base({
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.5,
        wdlAfterMaiaTop: undefined,
      }),
    );
    expect(a.variations.filter((v) => v.color === 'red')).toHaveLength(0);
  });

  it('НЕ добавляется если played = maiaTop (уже сыграли)', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'g1f3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.3), // mistake
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.5,
        wdlAfterMaiaTop: wdl(0.3),
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
        wdlAfterMaiaTop: wdl(0.2),
      }),
    );
    expect(a.variations.filter((v) => v.color === 'red')).toHaveLength(0);
  });
});

describe('buildAnnotation — §4.3 лимит ≤ 2', () => {
  it('одновременно green + red — ровно 2', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.3), // mistake (green)
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.3,
        wdlAfterMaiaTop: wdl(0.2), // blunder (red)
      }),
    );
    expect(a.variations).toHaveLength(2);
    expect(a.variations.map((v) => v.color).sort()).toEqual(['green', 'red']);
  });
});

describe('buildAnnotation — KS-3610 stabilized subline', () => {
  it('sfBestSubline (если задан) → используется вместо sfBestPv slice', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.2), // blunder
        sfBestPv: ['e2e4', 'e7e5', 'g1f3'],
        sfBestSubline: ['e7e5', 'g1f3', 'b8c6', 'f1c4'], // 4 хода (cap=8)
      }),
    );
    const green = a.variations.find((v) => v.color === 'green')!;
    expect(green.subline).toEqual(['e7e5', 'g1f3', 'b8c6', 'f1c4']);
  });

  it('sfBestSubline отсутствует → fallback на sfBestPv.slice(1, 3)', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'h2h3',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.2),
        sfBestPv: ['e2e4', 'e7e5', 'g1f3'],
      }),
    );
    const green = a.variations.find((v) => v.color === 'green')!;
    expect(green.subline).toEqual(['e7e5', 'g1f3']);
  });

  it('maiaTopSubline кладётся в red-variation если задан', () => {
    const a = buildAnnotation(
      base({
        playedUci: 'e2e4',
        sfBestUci: 'e2e4',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.5),
        maiaTopUci: 'g1f3',
        maiaTopProb: 0.3,
        wdlAfterMaiaTop: wdl(0.3),
        maiaTopSubline: ['e7e5', 'd2d4'],
      }),
    );
    const red = a.variations.find((v) => v.color === 'red')!;
    expect(red.subline).toEqual(['e7e5', 'd2d4']);
  });

  it('симметрия: то же правило применяется для позиции «ход чёрных» (без бранч на сторону)', () => {
    // Позиция «ход чёрных»: после 1.e4.
    const fenBlackToMove =
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const a = buildAnnotation(
      base({
        ply: 2,
        fen: fenBlackToMove,
        playedUci: 'h7h6',
        sfBestUci: 'e7e5',
        wdlBefore: wdl(0.5),
        wdlAfterPlayed: wdl(0.2), // blunder для чёрных
        wdlAfterBest: wdl(0.5),
        sfBestPv: ['e7e5', 'g1f3', 'b8c6'],
      }),
    );
    expect(a.nag).toEqual([NAG_BLUNDER]);
    const green = a.variations.find((v) => v.color === 'green')!;
    expect(green.uci).toBe('e7e5');
  });
});

describe('buildAnnotations — batch helper', () => {
  it('сохраняет длину массива и порядок ply', () => {
    const out = buildAnnotations([
      base({ ply: 1 }),
      base({ ply: 2 }),
      base({ ply: 3 }),
    ]);
    expect(out.map((a) => a.ply)).toEqual([1, 2, 3]);
  });
});
