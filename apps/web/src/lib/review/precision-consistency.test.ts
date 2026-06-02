/**
 * KS-3607. Регрессионный тест согласованности `buildAnnotation` с
 * precision-модулем: одно и то же `classifyMove` под капотом → один
 * вердикт. Если precision на конкретной позиции сказал `blunder`, авто-
 * NAG обязан поставить `??` (код 4). И так для каждого класса.
 *
 * Подобраны Wdl-перепады, попадающие в каждый bucket по
 * `WDL_LOSS_THRESHOLDS` (best≤0.02, good≤0.05, inaccuracy≤0.12,
 * mistake≤0.25, blunder>0.25, + mate-edge `l>950`).
 */
import { describe, it, expect } from 'vitest';

import { classifyMove, type MoveClass, type Wdl } from '@kingside/shared';

import {
  NAG_BLUNDER,
  NAG_MISTAKE,
  NAG_DUBIOUS,
  NAG_GOOD,
  NAG_BRILLIANT,
  buildAnnotation,
  type MoveInput,
} from './buildAnnotations';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function wdl(E: number): Wdl {
  const w = Math.round(E * 1000);
  return { w, d: 0, l: 1000 - w };
}

function makeInput(over: Partial<MoveInput> = {}): MoveInput {
  return {
    ply: 1,
    fen: STARTPOS,
    playedUci: 'h2h3',
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

interface Scenario {
  label: string;
  /** ожидаемый класс от precision (через classifyMove) */
  expectedClass: MoveClass;
  /** ожидаемый NAG-код от buildAnnotation */
  expectedNag: number[];
  /** входы для buildAnnotation */
  input: MoveInput;
}

const SCENARIOS: Scenario[] = [
  {
    label: 'precision=blunder → авто-NAG ?? (WDL-loss 0.30)',
    expectedClass: 'blunder',
    expectedNag: [NAG_BLUNDER],
    input: makeInput({
      wdlBefore: wdl(0.5),
      wdlAfterPlayed: wdl(0.2),
    }),
  },
  {
    label: 'precision=blunder через mate-edge (wdl_after.l > 950)',
    expectedClass: 'blunder',
    expectedNag: [NAG_BLUNDER],
    input: makeInput({
      wdlBefore: wdl(0.5),
      wdlAfterPlayed: { w: 5, d: 35, l: 960 },
    }),
  },
  {
    label: 'precision=mistake → авто-NAG ? (WDL-loss 0.20)',
    expectedClass: 'mistake',
    expectedNag: [NAG_MISTAKE],
    input: makeInput({
      wdlBefore: wdl(0.5),
      wdlAfterPlayed: wdl(0.3),
    }),
  },
  {
    label: 'precision=inaccuracy → авто-NAG ?! (WDL-loss 0.10)',
    expectedClass: 'inaccuracy',
    expectedNag: [NAG_DUBIOUS],
    input: makeInput({
      wdlBefore: wdl(0.5),
      wdlAfterPlayed: wdl(0.4),
    }),
  },
  {
    label: 'precision=best на SF top-1 + редкий playedProb<0.10 → авто-NAG !',
    expectedClass: 'best',
    expectedNag: [NAG_GOOD],
    input: makeInput({
      playedUci: 'e2e4',
      sfBestUci: 'e2e4',
      wdlBefore: wdl(0.5),
      wdlAfterPlayed: wdl(0.5),
      playedProb: 0.05,
    }),
  },
  {
    label:
      'precision=best на SF top-1 + единственное спасение (secondBestClass=mistake) → авто-NAG !!',
    expectedClass: 'best',
    expectedNag: [NAG_BRILLIANT],
    input: makeInput({
      playedUci: 'e2e4',
      sfBestUci: 'e2e4',
      wdlBefore: wdl(0.5),
      wdlAfterPlayed: wdl(0.5),
      wdlAfterSecondBest: wdl(0.3),
      playedProb: 0.04,
    }),
  },
];

describe('Precision ↔ авто-NAG consistency (KS-3607)', () => {
  it.each(SCENARIOS)('$label', (sc) => {
    // Precision (или любой другой потребитель) увидит тот же класс:
    const klass = classifyMove({
      wdlBefore: sc.input.wdlBefore,
      wdlAfter: sc.input.wdlAfterPlayed,
      isBestMove: sc.input.playedUci === sc.input.sfBestUci,
    });
    expect(klass).toBe(sc.expectedClass);

    // buildAnnotation выдаёт ожидаемый NAG-код:
    const a = buildAnnotation(sc.input);
    expect(a.nag).toEqual(sc.expectedNag);
  });

  it('обратная согласованность: при precision=good (loss 0.04) — нет quality-NAG', () => {
    const input = makeInput({
      playedUci: 'g1f3',
      sfBestUci: 'e2e4',
      wdlBefore: wdl(0.5),
      wdlAfterPlayed: wdl(0.46),
      playedProb: 0.25, // < 0.30, чтобы и !? тоже не сработало
    });
    const klass = classifyMove({
      wdlBefore: input.wdlBefore,
      wdlAfter: input.wdlAfterPlayed,
      isBestMove: false,
    });
    expect(klass).toBe('good');
    const a = buildAnnotation(input);
    expect(a.nag).toEqual([]);
  });

  it('KS-3617: decided до и после в одну сторону → suppress (шум в выигранной)', () => {
    const input = makeInput({
      wdlBefore: { w: 970, d: 20, l: 10 }, // signed=+0.96
      wdlAfterPlayed: { w: 980, d: 15, l: 5 }, // signed=+0.975 — оба decided one side
    });
    const a = buildAnnotation(input);
    // Оба сигнала по одну сторону decided-границы — авто-NAG suppress.
    expect(a.nag).toEqual([]);
  });

  it('KS-3617: decided до, после переход через границу → авто-NAG ставится', () => {
    const input = makeInput({
      wdlBefore: { w: 970, d: 20, l: 10 }, // signed=0.96 (decided)
      wdlAfterPlayed: wdl(0.2), // signed=-0.6 (упустили выигрыш)
    });
    const klass = classifyMove({
      wdlBefore: input.wdlBefore,
      wdlAfter: input.wdlAfterPlayed,
    });
    expect(klass).toBe('blunder');
    const a = buildAnnotation(input);
    // Симметричный suppress §3.3 (KS-3617): здесь позиция перешла из
    // decided в not-decided — это упущение, NAG обязан стоять.
    expect(a.nag).toEqual([NAG_BLUNDER]);
  });
});
