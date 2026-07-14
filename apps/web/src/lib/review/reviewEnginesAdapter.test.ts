/**
 * KS-4945 (ADR-165). Тесты адаптера ReviewEngines → PositionReviewEngines:
 * маппинг Maia/SF, порядок MultiPV best-first, терминал, деградация no_coi,
 * applyMove/toSan.
 */
import { describe, it, expect } from 'vitest';
import type { Wdl } from '@kingside/shared';

import { createReviewEngines } from './reviewEnginesAdapter';
import type { ReviewEngines, SfPositionResult, MaiaPolicy } from '../../hooks/useGameReview';

const W: Wdl = { w: 600, d: 300, l: 100 };

function fakeEngines(over: Partial<ReviewEngines> = {}): ReviewEngines {
  return {
    analyzeSf: async (): Promise<SfPositionResult> => ({
      bestUci: 'e2e4',
      wdlBefore: W,
      wdlAfterBest: W,
      wdlAfterSecondBest: null,
      bestPv: ['e2e4'],
      wdlByMove: { e2e4: W, d2d4: W },
      legalMovesCount: 20,
    }),
    evalMove: async () => W,
    predictMaia: async (): Promise<MaiaPolicy> => ({
      byUci: { e2e4: 0.6, d2d4: 0.4 },
      topUci: 'e2e4',
      topProb: 0.6,
    }),
    terminate: () => {},
    ...over,
  };
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('createReviewEngines', () => {
  it('getMaiaPolicy отдаёт byUci', async () => {
    const a = createReviewEngines(fakeEngines());
    expect(await a.getMaiaPolicy(START, 1500)).toEqual({ e2e4: 0.6, d2d4: 0.4 });
  });

  it('analyze: bestUci + wdl + multipv best-first', async () => {
    const a = createReviewEngines(fakeEngines());
    const r = await a.analyze(START, 2);
    expect(r).not.toBeNull();
    expect(r!.bestUci).toBe('e2e4');
    expect(r!.wdl).toEqual(W);
    expect(r!.multipv[0]).toBe('e2e4'); // best первым
    expect(r!.multipv).toContain('d2d4');
  });

  it('терминал (пустой bestmove) → bestUci null, multipv пуст', async () => {
    const a = createReviewEngines(
      fakeEngines({
        analyzeSf: async () => ({
          bestUci: '',
          wdlBefore: { w: 0, d: 0, l: 1000 },
          wdlAfterBest: { w: 0, d: 0, l: 1000 },
          wdlAfterSecondBest: null,
          bestPv: [],
          wdlByMove: {},
          legalMovesCount: 0,
        }),
      }),
    );
    const r = await a.analyze(START, 2);
    expect(r!.bestUci).toBeNull();
    expect(r!.multipv).toEqual([]);
  });

  it('деградация no_coi (sfEnabled=false) → analyze всегда null', async () => {
    const a = createReviewEngines(fakeEngines(), { sfEnabled: false });
    expect(await a.analyze(START, 2)).toBeNull();
    // Maia при этом продолжает работать.
    expect(await a.getMaiaPolicy(START, 1500)).toHaveProperty('e2e4');
  });

  it('applyMove применяет легальный ход и отдаёт FEN; нелегальный → null', async () => {
    const a = createReviewEngines(fakeEngines());
    const next = a.applyMove(START, 'e2e4');
    expect(typeof next).toBe('string');
    expect(next).toContain(' b '); // ход перешёл к чёрным
    expect(a.applyMove(START, 'e2e5')).toBeNull(); // нелегальный
    expect(a.applyMove(START, 'zz')).toBeNull(); // мусор
  });

  it('toSan переводит UCI в SAN', async () => {
    const a = createReviewEngines(fakeEngines());
    expect(a.toSan(START, 'e2e4')).toBe('e4');
    expect(a.toSan(START, 'g1f3')).toBe('Nf3');
  });
});
