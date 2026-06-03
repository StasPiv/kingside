/**
 * KS-3632/KS-3633 / ADR-104. Unit-тесты pure-функций Maia engine,
 * без реальной ONNX-сессии. Покрыт `postprocessMaia3` —
 * единственная нетривиальная логика без I/O.
 */
import { describe, expect, it } from 'vitest';

import { postprocessMaia3 } from './engine.js';
import {
  MAIA3_MOVE_VOCAB_SIZE,
  allPossibleMovesMaia3,
  mirrorMove,
  preprocessMaia3,
} from './tensor.js';

function logitsBiasedToIndex(
  idx: number,
  bias = 5,
): Float32Array {
  const v = new Float32Array(MAIA3_MOVE_VOCAB_SIZE);
  v[idx] = bias;
  return v;
}

function makeLegalMaskOnly(indices: number[]): Float32Array {
  const mask = new Float32Array(MAIA3_MOVE_VOCAB_SIZE);
  for (const i of indices) mask[i] = 1;
  return mask;
}

describe('preprocessMaia3', () => {
  it('startpos (white to move) → blackToMove=false, 20 legal moves', () => {
    const { legalMoves, blackToMove } = preprocessMaia3(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    let count = 0;
    for (let i = 0; i < legalMoves.length; i++) if (legalMoves[i] > 0) count++;
    expect(blackToMove).toBe(false);
    expect(count).toBe(20);
  });

  it('startpos после e2e4 (black to move) → blackToMove=true, mirror', () => {
    const { blackToMove } = preprocessMaia3(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    );
    expect(blackToMove).toBe(true);
  });

  it('кривой FEN без side-to-move → throws', () => {
    expect(() => preprocessMaia3('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR')).toThrow(
      /Invalid FEN/,
    );
  });
});

describe('mirrorMove', () => {
  it('e2e4 ↔ e7e5', () => {
    expect(mirrorMove('e2e4')).toBe('e7e5');
    expect(mirrorMove('e7e5')).toBe('e2e4');
  });
  it('promotion сохраняется', () => {
    expect(mirrorMove('e7e8q')).toBe('e2e1q');
  });
});

describe('postprocessMaia3', () => {
  it('softmax только по легальным; нелегальные исключены', () => {
    // Берём первые два UCI из словаря, делаем оба легальными.
    const uciKeys = Object.keys(allPossibleMovesMaia3);
    const uci1 = uciKeys[0];
    const uci2 = uciKeys[1];
    const idx1 = allPossibleMovesMaia3[uci1];
    const idx2 = allPossibleMovesMaia3[uci2];

    // Logits: idx1=5, idx2=5 → одинаковые вероятности 0.5/0.5.
    const logitsMove = new Float32Array(MAIA3_MOVE_VOCAB_SIZE);
    logitsMove[idx1] = 5;
    logitsMove[idx2] = 5;
    // Нелегальный третий с большим logits — не должен влиять.
    const idx3 = allPossibleMovesMaia3[uciKeys[2]];
    logitsMove[idx3] = 100;

    const legal = makeLegalMaskOnly([idx1, idx2]);
    const logitsValue = new Float32Array([0, 0, 0]);

    const result = postprocessMaia3(logitsMove, logitsValue, legal, false);

    expect(result.policy).toHaveLength(2);
    const sum = result.policy.reduce((a, b) => a + b.probability, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(result.policy[0].probability).toBeCloseTo(0.5, 5);
    expect(result.policy[1].probability).toBeCloseTo(0.5, 5);
  });

  it('возвращает только легальные ходы (не выдумывает)', () => {
    const uciKeys = Object.keys(allPossibleMovesMaia3);
    const idxLegal = allPossibleMovesMaia3[uciKeys[0]];
    const legal = makeLegalMaskOnly([idxLegal]);
    const logitsMove = logitsBiasedToIndex(idxLegal);
    const logitsValue = new Float32Array([0, 0, 0]);

    const result = postprocessMaia3(logitsMove, logitsValue, legal, false);
    expect(result.policy).toHaveLength(1);
    expect(result.policy[0].move).toBe(uciKeys[0]);
    expect(result.policy[0].probability).toBeCloseTo(1, 5);
  });

  it('сортирует policy по убыванию probability', () => {
    const uciKeys = Object.keys(allPossibleMovesMaia3);
    const i1 = allPossibleMovesMaia3[uciKeys[0]];
    const i2 = allPossibleMovesMaia3[uciKeys[1]];
    const i3 = allPossibleMovesMaia3[uciKeys[2]];
    const logitsMove = new Float32Array(MAIA3_MOVE_VOCAB_SIZE);
    logitsMove[i1] = 1;
    logitsMove[i2] = 5;
    logitsMove[i3] = 3;
    const legal = makeLegalMaskOnly([i1, i2, i3]);

    const result = postprocessMaia3(
      logitsMove,
      new Float32Array([0, 0, 0]),
      legal,
      false,
    );
    expect(result.policy[0].probability).toBeGreaterThan(
      result.policy[1].probability,
    );
    expect(result.policy[1].probability).toBeGreaterThan(
      result.policy[2].probability,
    );
  });

  it('winProbability: WDL [-2, 0, 2] → win softmax ~0.88 (white)', () => {
    const result = postprocessMaia3(
      new Float32Array(MAIA3_MOVE_VOCAB_SIZE),
      new Float32Array([-2, 0, 2]),
      new Float32Array(MAIA3_MOVE_VOCAB_SIZE), // нет легальных → policy=[]
      false,
    );
    // softmax([-2, 0, 2]) ≈ [0.016, 0.117, 0.867]; winProb = 0.867 + 0.5*0.117 ≈ 0.925
    expect(result.winProbability).toBeGreaterThan(0.9);
    expect(result.winProbability).toBeLessThan(0.95);
    expect(result.policy).toEqual([]);
  });

  it('blackToMove=true → winProb инвертируется', () => {
    const wWhite = postprocessMaia3(
      new Float32Array(MAIA3_MOVE_VOCAB_SIZE),
      new Float32Array([-2, 0, 2]),
      new Float32Array(MAIA3_MOVE_VOCAB_SIZE),
      false,
    ).winProbability;
    const wBlack = postprocessMaia3(
      new Float32Array(MAIA3_MOVE_VOCAB_SIZE),
      new Float32Array([-2, 0, 2]),
      new Float32Array(MAIA3_MOVE_VOCAB_SIZE),
      true,
    ).winProbability;
    expect(wBlack).toBeCloseTo(1 - wWhite, 4);
  });

  it('blackToMove=true: ходы декодируются через mirrorMove', () => {
    const uciKeys = Object.keys(allPossibleMovesMaia3);
    // Найдём UCI, чьё зеркало тоже валидно (любая обычная клетка).
    const uci = 'e2e4';
    const idx = allPossibleMovesMaia3[uci];
    if (idx === undefined) {
      // если этого хода нет в словаре — просто проверим что не падаем
      return;
    }
    const legal = makeLegalMaskOnly([idx]);
    const logitsMove = logitsBiasedToIndex(idx);

    const result = postprocessMaia3(
      logitsMove,
      new Float32Array([0, 0, 0]),
      legal,
      true,
    );
    expect(result.policy[0].move).toBe(mirrorMove(uci));
  });
});
