/**
 * KS-4945 (ADR-165). Тесты адаптера ReviewEngines → PositionReviewEngines:
 * маппинг Maia/SF, порядок MultiPV best-first, терминал, деградация no_coi,
 * applyMove/toSan.
 */
import { describe, it, expect } from 'vitest';
import type { Wdl } from '@kingside/shared';

import { createReviewEngines, whiteEvalLineFromWdlAfter } from './reviewEnginesAdapter';
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

describe('whiteEvalLineFromWdlAfter (KS-4950 градусник, POV белых)', () => {
  const WIN: Wdl = { w: 950, d: 30, l: 20 }; // POV ходившего — выигрыш

  it('белые сходили в выигранную позицию → cp > 0 (перевес белых)', () => {
    const line = whiteEvalLineFromWdlAfter(WIN, true);
    expect(line.score.type).toBe('cp');
    expect(line.score.value).toBeGreaterThan(0);
  });
  it('чёрные сходили в выигранную (для чёрных) позицию → cp < 0', () => {
    const line = whiteEvalLineFromWdlAfter(WIN, false);
    expect(line.score.value).toBeLessThan(0);
  });
  it('одна и та же оценка не зависит от чётности полухода (не скачет)', () => {
    // Белые выиграли (+) и следом чёрные проиграли (тот же WDL, но mover=чёрные)
    // → для белых обе позиции выиграны, знак cp одинаковый (плюс).
    const whiteMoved = whiteEvalLineFromWdlAfter(WIN, true);
    const blackMovedLosing = whiteEvalLineFromWdlAfter({ w: 20, d: 30, l: 950 }, false);
    expect(whiteMoved.score.value).toBeGreaterThan(0);
    expect(blackMovedLosing.score.value).toBeGreaterThan(0);
  });
  it('равная позиция → около нуля', () => {
    const line = whiteEvalLineFromWdlAfter({ w: 250, d: 500, l: 250 }, true);
    expect(Math.abs(line.score.value)).toBeLessThan(30);
  });
});
