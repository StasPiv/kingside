/**
 * KS-3640 / ADR-106 §2.1. Unit-тесты pure-вычисления
 * `maiaWeakChoiceProb`. Без реальных SF/Maia — синтетика.
 */
import { describe, expect, it } from 'vitest';

import {
  MAIA_TOP_K_MAX,
  MAIA_TOP_K_POLICY_THRESHOLD,
  MAIA_WEAK_CHOICE_METRIC_VERSION,
  WEAK_LOSS_E_THRESHOLD,
  buildMaiaSearchMoves,
  computeWeakChoiceProb,
} from './weak-choice.js';

describe('MAIA_WEAK_CHOICE_METRIC_VERSION', () => {
  it('экспортирована = 1 (ADR-106 §2.5 версия 1 формулы)', () => {
    expect(MAIA_WEAK_CHOICE_METRIC_VERSION).toBe(1);
  });
});

describe('buildMaiaSearchMoves', () => {
  it('отрезает ходы с policy ≤ 0.10 и кэпит K_max=8', () => {
    // 12 ходов с убывающими вероятностями. Первые 8 > 0.10 → попадают.
    const policy = [
      { move: 'a1', probability: 0.4 },
      { move: 'a2', probability: 0.2 },
      { move: 'a3', probability: 0.15 },
      { move: 'a4', probability: 0.12 },
      { move: 'a5', probability: 0.11 },
      { move: 'a6', probability: 0.105 },
      { move: 'a7', probability: 0.102 },
      { move: 'a8', probability: 0.101 },
      { move: 'a9', probability: 0.1 }, // ровно граница — НЕ входит (> 0.10).
      { move: 'b1', probability: 0.09 },
      { move: 'b2', probability: 0.05 },
      { move: 'b3', probability: 0.01 },
    ];
    const { maiaTopK } = buildMaiaSearchMoves(policy, 'a1');
    expect(maiaTopK).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']);
    expect(maiaTopK.length).toBeLessThanOrEqual(MAIA_TOP_K_MAX);
    expect(MAIA_TOP_K_POLICY_THRESHOLD).toBe(0.1);
  });

  it('firstMovePV1 первый в searchMoves, дубль с MaiaTopK не плодит', () => {
    const policy = [
      { move: 'e2e4', probability: 0.6 },
      { move: 'd2d4', probability: 0.3 },
    ];
    const { searchMoves } = buildMaiaSearchMoves(policy, 'e2e4');
    expect(searchMoves[0]).toBe('e2e4');
    expect(searchMoves).toEqual(['e2e4', 'd2d4']);
  });

  it('firstMovePV1 не в MaiaTopK — добавляется опорной точкой', () => {
    const policy = [
      { move: 'd2d4', probability: 0.7 },
      { move: 'g1f3', probability: 0.2 },
    ];
    const { searchMoves, maiaTopK } = buildMaiaSearchMoves(policy, 'e2e4');
    // MaiaTopK содержит ТОЛЬКО Maia-кандидатов (firstMovePV1 туда не
    // подмешивается, даже если он не выбран Maia).
    expect(maiaTopK).toEqual(['d2d4', 'g1f3']);
    // searchMoves включает firstMovePV1 первым.
    expect(searchMoves).toEqual(['e2e4', 'd2d4', 'g1f3']);
  });

  it('сортирует по убыванию даже если входной массив не отсортирован', () => {
    const policy = [
      { move: 'low', probability: 0.11 },
      { move: 'mid', probability: 0.35 },
      { move: 'top', probability: 0.45 },
    ];
    const { maiaTopK } = buildMaiaSearchMoves(policy, 'top');
    expect(maiaTopK).toEqual(['top', 'mid', 'low']);
  });

  it('пустой policy → maiaTopK пустой, searchMoves = [firstMovePV1]', () => {
    const { maiaTopK, searchMoves } = buildMaiaSearchMoves([], 'e2e4');
    expect(maiaTopK).toEqual([]);
    expect(searchMoves).toEqual(['e2e4']);
  });
});

describe('computeWeakChoiceProb', () => {
  it('однозначная позиция: только один сильный → weak_set пуст, prob=0', () => {
    // Один сильный (E=0.9), остальные с policy ≤ 0.10 не попадают в MaiaTopK.
    const policy = [
      { move: 'best', probability: 0.85 },
      { move: 'noise1', probability: 0.08 },
      { move: 'noise2', probability: 0.07 },
    ];
    const expectedScores = new Map([['best', 0.9]]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'best',
      expectedScores,
    });
    expect(r.maiaTopK).toEqual(['best']);
    expect(r.searchMoves).toEqual(['best']);
    expect(r.weakSet).toEqual([]);
    expect(r.weakChoiceProb).toBe(0);
    expect(r.bestExpectedScore).toBe(0.9);
  });

  it('два равно-сильных хода (loss ≤ 0.02) → weak_set пуст, prob=0', () => {
    const policy = [
      { move: 'a', probability: 0.55 },
      { move: 'b', probability: 0.4 },
    ];
    // a: E=0.80, b: E=0.79 → loss(b) = 0.01 ≤ 0.02 → не слабый.
    const expectedScores = new Map([
      ['a', 0.8],
      ['b', 0.79],
    ]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'a',
      expectedScores,
    });
    expect(r.weakSet).toEqual([]);
    expect(r.weakChoiceProb).toBe(0);
  });

  it('одна сильная + одна слабая в MaiaTopK → weak_set с одним, prob = policy(weak)', () => {
    // a — сильный (E=0.85), b — слабый (E=0.30, loss=0.55 > 0.02).
    const policy = [
      { move: 'a', probability: 0.6 },
      { move: 'b', probability: 0.35 },
    ];
    const expectedScores = new Map([
      ['a', 0.85],
      ['b', 0.3],
    ]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'a',
      expectedScores,
    });
    expect(r.weakSet).toHaveLength(1);
    expect(r.weakSet[0].move).toBe('b');
    expect(r.weakSet[0].policy).toBeCloseTo(0.35, 6);
    expect(r.weakSet[0].lossE).toBeCloseTo(0.55, 6);
    expect(r.weakChoiceProb).toBeCloseTo(0.35, 6);
    expect(r.bestExpectedScore).toBe(0.85);
  });

  it('несколько слабых → prob = Σ policy слабых', () => {
    // a — сильный (0.95), b/c/d — слабые с разной policy.
    const policy = [
      { move: 'a', probability: 0.4 },
      { move: 'b', probability: 0.25 },
      { move: 'c', probability: 0.2 },
      { move: 'd', probability: 0.15 },
    ];
    const expectedScores = new Map([
      ['a', 0.95],
      ['b', 0.5],
      ['c', 0.3],
      ['d', 0.92], // loss = 0.03 > 0.02 — слабый по чуть-чуть
    ]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'a',
      expectedScores,
    });
    // Все три (b, c, d) — слабые. prob = 0.25 + 0.2 + 0.15 = 0.6.
    expect(r.weakSet.map((w) => w.move).sort()).toEqual(['b', 'c', 'd']);
    expect(r.weakChoiceProb).toBeCloseTo(0.6, 6);
  });

  it('firstMovePV1 не в MaiaTopK, но определяет bestE через SF-eval', () => {
    // Maia не находит правильный ход (firstMovePV1=correct), а в её
    // топе тактически плохие. correct: E=0.9, x/y: E=0.3.
    const policy = [
      { move: 'x', probability: 0.5 },
      { move: 'y', probability: 0.4 },
    ];
    const expectedScores = new Map([
      ['correct', 0.9],
      ['x', 0.3],
      ['y', 0.32],
    ]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'correct',
      expectedScores,
    });
    // bestE = 0.9 (от correct). x и y — слабые (loss 0.6 и 0.58).
    expect(r.bestExpectedScore).toBe(0.9);
    expect(r.weakSet.map((w) => w.move).sort()).toEqual(['x', 'y']);
    // prob = 0.5 + 0.4 = 0.9.
    expect(r.weakChoiceProb).toBeCloseTo(0.9, 6);
  });

  it('expectedScores не содержит часть searchmoves → используется доступная', () => {
    // SF не вернул eval для 'b' (например out-of-MultiPV). Считаем
    // только по тем, где данные есть; weak_set пропускает.
    const policy = [
      { move: 'a', probability: 0.6 },
      { move: 'b', probability: 0.3 },
    ];
    const expectedScores = new Map([['a', 0.8]]); // нет 'b'
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'a',
      expectedScores,
    });
    expect(r.bestExpectedScore).toBe(0.8);
    expect(r.weakSet).toEqual([]);
    expect(r.weakChoiceProb).toBe(0);
  });

  it('expectedScores пустой → graceful: 0 без исключений', () => {
    const policy = [
      { move: 'a', probability: 0.6 },
      { move: 'b', probability: 0.3 },
    ];
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'a',
      expectedScores: new Map(),
    });
    expect(r.weakChoiceProb).toBe(0);
    expect(r.bestExpectedScore).toBe(0);
    expect(r.weakSet).toEqual([]);
  });

  // Граница порога — `loss_E > 0.02` (строгое). На реальных WDL
  // per-mille дискретность шага 0.001, граничные случаи маловероятны;
  // тесты на ниже/выше порога с запасом, чтобы не зависеть от
  // IEEE-754 неточности на 0.5 − 0.48 (выходит 0.0200000000000000018).
  it('loss_E = 0.019 (ниже порога 0.02) — НЕ слабый', () => {
    const policy = [
      { move: 'best', probability: 0.5 },
      { move: 'b', probability: 0.4 },
    ];
    const expectedScores = new Map([
      ['best', 0.5],
      ['b', 0.481],
    ]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'best',
      expectedScores,
    });
    expect(r.weakSet).toEqual([]);
    expect(r.weakChoiceProb).toBe(0);
    expect(WEAK_LOSS_E_THRESHOLD).toBe(0.02);
  });

  it('loss_E = 0.021 (выше порога 0.02) — слабый', () => {
    const policy = [
      { move: 'best', probability: 0.5 },
      { move: 'b', probability: 0.4 },
    ];
    const expectedScores = new Map([
      ['best', 0.5],
      ['b', 0.479],
    ]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'best',
      expectedScores,
    });
    expect(r.weakSet).toHaveLength(1);
    expect(r.weakSet[0].move).toBe('b');
    expect(r.weakChoiceProb).toBeCloseTo(0.4, 6);
  });
});
