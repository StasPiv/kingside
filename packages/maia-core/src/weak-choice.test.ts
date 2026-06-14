/**
 * KS-3640 / ADR-106 §2.1 + KS-4107 (soft-threshold v2). Unit-тесты
 * pure-вычисления `maiaWeakChoiceProb`. Без реальных SF/Maia — синтетика.
 */
import { describe, expect, it } from 'vitest';

import {
  MAIA_TOP_K_MAX,
  MAIA_TOP_K_POLICY_THRESHOLD,
  MAIA_WEAK_CHOICE_METRIC_VERSION,
  WEAK_LOSS_E_CENTER,
  WEAK_LOSS_E_SOFT_WIDTH,
  WEAK_LOSS_E_THRESHOLD,
  buildMaiaSearchMoves,
  computeWeakChoiceProb,
  weakWeight,
} from './weak-choice.js';

describe('MAIA_WEAK_CHOICE_METRIC_VERSION', () => {
  it('экспортирована = 2 (KS-4107: soft-threshold версия 2 формулы)', () => {
    expect(MAIA_WEAK_CHOICE_METRIC_VERSION).toBe(2);
  });
});

describe('weakWeight (KS-4107 soft-threshold)', () => {
  it('константы центра и ширины соответствуют ADR-106 §2.1 + KS-4107', () => {
    expect(WEAK_LOSS_E_CENTER).toBe(0.02);
    expect(WEAK_LOSS_E_SOFT_WIDTH).toBe(0.01);
    // Deprecated алиас сохранён для совместимости.
    expect(WEAK_LOSS_E_THRESHOLD).toBe(WEAK_LOSS_E_CENTER);
  });

  it('loss_E на левой границе и ниже → weight = 0 (точно сильный)', () => {
    expect(weakWeight(0.015)).toBe(0);
    expect(weakWeight(0.01)).toBe(0);
    expect(weakWeight(0)).toBe(0);
    expect(weakWeight(-0.5)).toBe(0);
  });

  it('loss_E на правой границе и выше → weight = 1 (точно слабый)', () => {
    expect(weakWeight(0.025)).toBe(1);
    expect(weakWeight(0.05)).toBe(1);
    expect(weakWeight(0.5)).toBe(1);
  });

  it('loss_E = center (0.02) → weight = 0.5', () => {
    expect(weakWeight(0.02)).toBeCloseTo(0.5, 9);
  });

  it('линейный переход внутри [center-w/2, center+w/2]', () => {
    expect(weakWeight(0.016)).toBeCloseTo(0.1, 9);
    expect(weakWeight(0.018)).toBeCloseTo(0.3, 9);
    expect(weakWeight(0.022)).toBeCloseTo(0.7, 9);
    expect(weakWeight(0.024)).toBeCloseTo(0.9, 9);
  });

  it('настраиваемые center/width переопределяют дефолты', () => {
    // Центр 0.05, ширина 0.02 → переход [0.04 .. 0.06].
    expect(weakWeight(0.04, 0.05, 0.02)).toBe(0);
    expect(weakWeight(0.05, 0.05, 0.02)).toBeCloseTo(0.5, 9);
    // Чуть выше правой границы → точно 1 (IEEE-754 на самой границе
    // даёт 0.999...; реальные WDL дискретны per-mille, попадание
    // ровно в граничную точку невероятно).
    expect(weakWeight(0.0601, 0.05, 0.02)).toBe(1);
    expect(weakWeight(0.06, 0.05, 0.02)).toBeCloseTo(1, 9);
  });

  it('width = 0 деградирует в ступеньку (legacy v1 совместимость)', () => {
    expect(weakWeight(0.019, 0.02, 0)).toBe(0);
    expect(weakWeight(0.02, 0.02, 0)).toBe(0); // strict >
    expect(weakWeight(0.021, 0.02, 0)).toBe(1);
  });

  it('устойчивость к тысячным WDL у границы — мотивация KS-4107', () => {
    // Главная цель soft-threshold: расхождение SF18 vs SF15.1 в
    // тысячные WDL → разница weight в сотые, не флип 0↔1.
    const w1 = weakWeight(0.0199); // SF15.1 даёт чуть ниже центра
    const w2 = weakWeight(0.0201); // SF18 даёт чуть выше центра
    // У старой ступеньки это давало 0 vs 1 (Δ = 1.0).
    // У soft-threshold: |Δw| ≈ 0.02, на порядки меньше.
    expect(Math.abs(w1 - w2)).toBeLessThan(0.05);
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

  it('два равно-сильных хода (loss ≤ 0.015) → weak_set пуст, prob=0', () => {
    const policy = [
      { move: 'a', probability: 0.55 },
      { move: 'b', probability: 0.4 },
    ];
    // a: E=0.80, b: E=0.79 → loss(b) = 0.01 ≤ 0.015 (нижняя граница
    // soft-threshold) → weight = 0 → не слабый.
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
    // a — сильный (E=0.85), b — слабый (E=0.30, loss=0.55 ≫ 0.025).
    // У такого loss weight = 1, поэтому prob = policy[b] · 1 = 0.35
    // (то же что и в v1; soft-threshold расходится с v1 только в
    // переходной зоне loss ∈ [0.015..0.025]).
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
    expect(r.weakSet[0].weight).toBe(1);
    expect(r.weakChoiceProb).toBeCloseTo(0.35, 6);
    expect(r.bestExpectedScore).toBe(0.85);
  });

  it('несколько слабых вне переходной зоны → prob = Σ policy слабых', () => {
    // a — сильный (0.95), b/c — слабые (loss ≫ 0.025) с weight=1.
    // d убран: loss=0.03 в v1 был слабым (>0.02), а у soft v2 —
    // переходная зона, weight = (0.03-0.015)/0.01 → насыщение = 1
    // (только если loss ≥ 0.025; 0.03 = 1.0). Оставляем все три.
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
      ['d', 0.92], // loss = 0.03 ≥ 0.025 → weight = 1
    ]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'a',
      expectedScores,
    });
    expect(r.weakSet.map((w) => w.move).sort()).toEqual(['b', 'c', 'd']);
    // Все три полностью слабые (weight=1): prob = 0.25 + 0.2 + 0.15 = 0.6.
    expect(r.weakChoiceProb).toBeCloseTo(0.6, 6);
  });

  it('ход в переходной зоне → дробный weight, вклад = policy·weight', () => {
    // KS-4107: главный кейс soft-threshold. Один сильный (loss=0) +
    // один в переходной зоне (loss=0.020 → weight=0.5) + один полностью
    // слабый (loss=0.05 → weight=1).
    const policy = [
      { move: 'a', probability: 0.5 },
      { move: 'b', probability: 0.3 }, // в переходной зоне
      { move: 'c', probability: 0.2 }, // полностью слабый
    ];
    const expectedScores = new Map([
      ['a', 0.8],
      ['b', 0.78], // loss = 0.02 → weight = 0.5
      ['c', 0.75], // loss = 0.05 → weight = 1
    ]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'a',
      expectedScores,
    });
    // weakSet — только b и c (a имеет weight=0).
    expect(r.weakSet.map((w) => w.move).sort()).toEqual(['b', 'c']);
    const entryB = r.weakSet.find((w) => w.move === 'b')!;
    const entryC = r.weakSet.find((w) => w.move === 'c')!;
    expect(entryB.weight).toBeCloseTo(0.5, 9);
    expect(entryC.weight).toBe(1);
    // prob = 0.3·0.5 + 0.2·1 = 0.15 + 0.20 = 0.35.
    expect(r.weakChoiceProb).toBeCloseTo(0.35, 6);
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
    // bestE = 0.9. x и y — полностью слабые (loss 0.6 и 0.58 ≫ 0.025),
    // weight = 1 у обоих → prob = 0.5 + 0.4 = 0.9.
    expect(r.bestExpectedScore).toBe(0.9);
    expect(r.weakSet.map((w) => w.move).sort()).toEqual(['x', 'y']);
    expect(r.weakSet.every((w) => w.weight === 1)).toBe(true);
    expect(r.weakChoiceProb).toBeCloseTo(0.9, 6);
  });

  it('настраиваемые weakLossCenter/weakLossSoftWidth через input', () => {
    // KS-4107: A/B-калибровка — caller может переопределить параметры.
    const policy = [
      { move: 'a', probability: 0.6 },
      { move: 'b', probability: 0.35 },
    ];
    const expectedScores = new Map([
      ['a', 0.5],
      ['b', 0.45], // loss = 0.05
    ]);
    // Дефолт: 0.05 ≥ 0.025 → weight=1, prob = 0.35.
    const rDefault = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'a',
      expectedScores,
    });
    expect(rDefault.weakChoiceProb).toBeCloseTo(0.35, 6);
    // Сдвинули центр на 0.1 (loss 0.05 < center-w/2=0.09): weight=0.
    const rShifted = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'a',
      expectedScores,
      weakLossCenter: 0.1,
      weakLossSoftWidth: 0.02,
    });
    expect(rShifted.weakChoiceProb).toBe(0);
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

  // KS-4107: soft-threshold вместо ступеньки. Граничные тесты —
  // непрерывный переход, не строгий флип. На дефолтных параметрах
  // (center=0.02, width=0.01) loss=0.015 даёт weight=0, loss=0.025
  // даёт weight=1, между ними — линейная интерполяция.
  it('loss_E = 0.010 (вне зоны слева) — НЕ слабый (prob=0)', () => {
    const policy = [
      { move: 'best', probability: 0.5 },
      { move: 'b', probability: 0.4 },
    ];
    const expectedScores = new Map([
      ['best', 0.5],
      ['b', 0.49], // loss = 0.01 ≤ 0.015
    ]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'best',
      expectedScores,
    });
    expect(r.weakSet).toEqual([]);
    expect(r.weakChoiceProb).toBe(0);
  });

  it('loss_E в переходной зоне (~0.02) — дробный weight, не флип', () => {
    // Главная цель KS-4107: тысячные у границы не флипают prob.
    // loss = 0.020 → weight = 0.5, prob = 0.4 · 0.5 = 0.2.
    const policy = [
      { move: 'best', probability: 0.5 },
      { move: 'b', probability: 0.4 },
    ];
    const expectedScores = new Map([
      ['best', 0.5],
      ['b', 0.48], // loss = 0.02 точно
    ]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'best',
      expectedScores,
    });
    expect(r.weakSet).toHaveLength(1);
    expect(r.weakSet[0].weight).toBeCloseTo(0.5, 6);
    expect(r.weakChoiceProb).toBeCloseTo(0.2, 6);
  });

  it('loss_E ≥ 0.025 (вне зоны справа) — полностью слабый (weight=1)', () => {
    const policy = [
      { move: 'best', probability: 0.5 },
      { move: 'b', probability: 0.4 },
    ];
    const expectedScores = new Map([
      ['best', 0.5],
      ['b', 0.475], // loss = 0.025 ровно
    ]);
    const r = computeWeakChoiceProb({
      policy,
      firstMovePV1: 'best',
      expectedScores,
    });
    expect(r.weakSet).toHaveLength(1);
    expect(r.weakSet[0].weight).toBe(1);
    expect(r.weakChoiceProb).toBeCloseTo(0.4, 6);
  });
});
