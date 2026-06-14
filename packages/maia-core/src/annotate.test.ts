/**
 * KS-4100 / ADR-124. Тест консолидированной оркестрации annotateWeakChoice
 * на моках движков (MaiaPolicySource + WeakChoiceAnalysisEngine).
 * Golden-вектор weakChoiceProb — гард паритета клиент↔сервер.
 */
import { describe, expect, it } from 'vitest';
import {
  annotateWeakChoice,
  type MaiaPolicySource,
  type WeakChoiceAnalysisEngine,
  type WeakChoiceLine,
} from './annotate.js';
import { MAIA_WEAK_CHOICE_METRIC_VERSION } from './weak-choice.js';
import type { MovePrediction, PredictResult } from './engine.js';

function maiaMock(policy: MovePrediction[]): MaiaPolicySource {
  return {
    predictMoves: async (): Promise<PredictResult> => ({
      policy,
      winProbability: 0,
    }),
  };
}

function engineMock(lines: WeakChoiceLine[]): WeakChoiceAnalysisEngine {
  return {
    analyzeWithWdl: async (): Promise<WeakChoiceLine[]> => lines,
  };
}

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('annotateWeakChoice (ADR-124 §2.2)', () => {
  it('один явно слабый ход → weakChoiceProb = его policy', async () => {
    const maia = maiaMock([
      { move: 'e2e4', probability: 0.5 },
      { move: 'd2d4', probability: 0.3 },
      { move: 'g1f3', probability: 0.2 },
    ]);
    const engine = engineMock([
      { bestMove: 'e2e4', score: { type: 'cp', value: 50 }, wdl: { w: 900, d: 80, l: 20 } }, // E=0.94 (best)
      { bestMove: 'd2d4', score: { type: 'cp', value: 45 }, wdl: { w: 880, d: 90, l: 30 } }, // E=0.925 (loss 0.015 < 0.02 — НЕ слабый)
      { bestMove: 'g1f3', score: { type: 'cp', value: 10 }, wdl: { w: 600, d: 200, l: 200 } }, // E=0.70 (loss 0.24 — слабый)
    ]);
    const res = await annotateWeakChoice({
      fen: FEN,
      firstMovePV1: 'e2e4',
      maia,
      engine,
      elo: 1500,
    });
    expect(res).not.toBeNull();
    expect(res!.weakChoiceProb).toBeCloseTo(0.2, 4); // только g1f3 слабый
    expect(res!.metricVersion).toBe(MAIA_WEAK_CHOICE_METRIC_VERSION);
    expect(res!.elo).toBe(1500);
  });

  it('все ходы примерно равны (нет слабых) → weakChoiceProb ≈ 0', async () => {
    const maia = maiaMock([
      { move: 'e2e4', probability: 0.4 },
      { move: 'd2d4', probability: 0.35 },
      { move: 'g1f3', probability: 0.25 },
    ]);
    const engine = engineMock([
      { bestMove: 'e2e4', score: { type: 'cp', value: 30 }, wdl: { w: 850, d: 120, l: 30 } },
      { bestMove: 'd2d4', score: { type: 'cp', value: 30 }, wdl: { w: 850, d: 120, l: 30 } },
      { bestMove: 'g1f3', score: { type: 'cp', value: 29 }, wdl: { w: 848, d: 122, l: 30 } },
    ]);
    const res = await annotateWeakChoice({
      fen: FEN,
      firstMovePV1: 'e2e4',
      maia,
      engine,
      elo: 1500,
    });
    expect(res!.weakChoiceProb).toBeCloseTo(0, 4);
  });

  it('пустая policy → null', async () => {
    const res = await annotateWeakChoice({
      fen: FEN,
      firstMovePV1: 'e2e4',
      maia: maiaMock([]),
      engine: engineMock([]),
      elo: 1500,
    });
    expect(res).toBeNull();
  });

  it('searchMoves пуст (firstMovePV1 пуст + policy ниже порога TopK) → weakChoiceProb 0', async () => {
    // 12 равновероятных ходов по ~0.083 < 0.10 порога → MaiaTopK пуст,
    // firstMovePV1='' → searchMoves пуст.
    const policy: MovePrediction[] = Array.from({ length: 12 }, (_, i) => ({
      move: `m${i}`,
      probability: 1 / 12,
    }));
    const res = await annotateWeakChoice({
      fen: FEN,
      firstMovePV1: '',
      maia: maiaMock(policy),
      engine: engineMock([]),
      elo: 1500,
    });
    expect(res).not.toBeNull();
    expect(res!.weakChoiceProb).toBe(0);
  });

  it('исключение движка пробрасывается (хост ловит, не глушим)', async () => {
    const maia = maiaMock([{ move: 'e2e4', probability: 1 }]);
    const engine: WeakChoiceAnalysisEngine = {
      analyzeWithWdl: async () => {
        throw new Error('sf failed');
      },
    };
    await expect(
      annotateWeakChoice({ fen: FEN, firstMovePV1: 'e2e4', maia, engine, elo: 1500 }),
    ).rejects.toThrow('sf failed');
  });
});
