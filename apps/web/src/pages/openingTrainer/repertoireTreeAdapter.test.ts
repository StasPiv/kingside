import { describe, it, expect } from 'vitest';
import type { OpeningLineProgressDto, RepertoireTree } from '@kingside/shared';
import {
  basePlyOffsetFromRootFen,
  repertoireTreeToGameMoves,
} from './repertoireTreeAdapter';

const FEN_BLACK_MOVE8 =
  'r2qkb1r/pp1n1pp1/2p1pn1p/3pNb2/3P1BP1/3BP3/PPPN1P1P/R2QK2R b KQkq - 0 8';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('basePlyOffsetFromRootFen (KS-4967)', () => {
  it('startpos (w, 1) → 0', () => {
    expect(basePlyOffsetFromRootFen(START_FEN)).toBe(0);
  });

  it('чёрные к ходу, полный ход 8 → 15 (первый ход = 8…)', () => {
    expect(basePlyOffsetFromRootFen(FEN_BLACK_MOVE8)).toBe(15);
  });

  it('белые к ходу, полный ход 8 → 14 (первый ход = 8.)', () => {
    const fen = '8/8/8/8/8/8/8/8 w - - 0 8';
    expect(basePlyOffsetFromRootFen(fen)).toBe(14);
  });

  it('литерал «start» и мусорный FEN → 0 (без регрессий)', () => {
    expect(basePlyOffsetFromRootFen('start')).toBe(0);
    expect(basePlyOffsetFromRootFen('')).toBe(0);
  });
});

function makeLine(pathUci: string[]): OpeningLineProgressDto {
  return {
    id: 'l',
    repertoireId: 'r',
    pathHash: 'h',
    pathUci,
    pathLength: pathUci.length,
    correctCount: 0,
    wrongCount: 0,
    consecutiveCorrect: 0,
    lastPlayedAt: '2026-05-24T00:00:00Z',
    masteredAt: null,
    sm2DueAt: null,
    sm2Interval: null,
    sm2Easiness: null,
    sm2Reps: null,
    orphaned: false,
    status: 'not-played',
  };
}

describe('repertoireTreeToGameMoves — ply от rootFen (KS-4967)', () => {
  it('rootFen с [FEN] «b … 8»: ply первого хода отражает смещение (8…Bxd3 9.cxd3)', () => {
    const tree: RepertoireTree = {
      rootFen: FEN_BLACK_MOVE8,
      nodes: {
        [FEN_BLACK_MOVE8]: {
          fen: FEN_BLACK_MOVE8,
          edges: [{ moveUci: 'f5d3', moveSan: 'Bxd3', childFen: 'after-bxd3' }],
        },
        'after-bxd3': {
          fen: 'after-bxd3',
          edges: [{ moveUci: 'c2d3', moveSan: 'cxd3', childFen: 'after-cxd3' }],
        },
        'after-cxd3': { fen: 'after-cxd3', edges: [] },
      },
      meta: { nodeCount: 3, edgeCount: 2, maxDepth: 2 },
    };
    const lines = [makeLine(['f5d3']), makeLine(['f5d3', 'c2d3'])];
    const moves = repertoireTreeToGameMoves(tree, lines);

    // Первый ход — чёрных, полный ход 8 → ply 16 (moveNumber 8, чётный=чёрные).
    expect(moves[0].san).toBe('Bxd3');
    expect(moves[0].ply).toBe(16);
    // Второй — белых, полный ход 9 → ply 17.
    expect(moves[1].san).toBe('cxd3');
    expect(moves[1].ply).toBe(17);
  });

  it('rootFen «start»: ply как прежде (первый ход = ply 1)', () => {
    const tree: RepertoireTree = {
      rootFen: 'start',
      nodes: {
        start: {
          fen: 'start',
          edges: [{ moveUci: 'e2e4', moveSan: 'e4', childFen: 'after-e4' }],
        },
        'after-e4': { fen: 'after-e4', edges: [] },
      },
      meta: { nodeCount: 2, edgeCount: 1, maxDepth: 1 },
    };
    const moves = repertoireTreeToGameMoves(tree, [makeLine(['e2e4'])]);
    expect(moves[0].san).toBe('e4');
    expect(moves[0].ply).toBe(1);
  });
});
