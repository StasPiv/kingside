/**
 * KS-3593. Тесты `engineSort.ts` — sortLines + evalCompare + extractBestUci.
 */
import { describe, it, expect } from 'vitest';

import { evalCompare, extractBestUci, sortLines } from './engineSort';
import type { EvalLine } from '../hooks/useStockfish';

function cp(multipv: number, value: number, pv: string): EvalLine {
  return {
    multipv,
    depth: 20,
    score: { type: 'cp', value },
    pv,
  };
}

function mate(multipv: number, value: number, pv: string): EvalLine {
  return {
    multipv,
    depth: 20,
    score: { type: 'mate', value },
    pv,
  };
}

describe('extractBestUci', () => {
  it('из строки PV возвращает первый UCI', () => {
    expect(extractBestUci('e2e4 e7e5 g1f3')).toBe('e2e4');
  });
  it('из массива (legacy test-mock) возвращает первый элемент', () => {
    expect(extractBestUci(['d2d4', 'd7d5'])).toBe('d2d4');
  });
  it('пустой/невалидный вход → null', () => {
    expect(extractBestUci('')).toBe(null);
    expect(extractBestUci(undefined)).toBe(null);
    expect(extractBestUci(null)).toBe(null);
    expect(extractBestUci([])).toBe(null);
  });
});

describe('evalCompare', () => {
  it('cp vs cp: больший value лучше (desc)', () => {
    expect(Math.sign(evalCompare(cp(1, 50, 'a'), cp(2, 30, 'a')))).toBe(-1);
    expect(Math.sign(evalCompare(cp(1, 10, 'a'), cp(2, 50, 'a')))).toBe(1);
  });
  it('+ mate бьёт cp', () => {
    expect(Math.sign(evalCompare(mate(1, 3, 'a'), cp(2, 999, 'b')))).toBe(-1);
  });
  it('cp бьёт − mate', () => {
    expect(Math.sign(evalCompare(cp(1, -500, 'a'), mate(2, -2, 'b')))).toBe(-1);
  });
  it('+ mate vs − mate: + лучше', () => {
    expect(Math.sign(evalCompare(mate(1, 5, 'a'), mate(2, -3, 'b')))).toBe(-1);
  });
  it('оба + mate: быстрее → лучше', () => {
    // M2 лучше M5
    expect(Math.sign(evalCompare(mate(1, 2, 'a'), mate(2, 5, 'b')))).toBe(-1);
  });
  it('оба − mate: дольше → лучше (нас не матуют сразу)', () => {
    // -M5 (нас матуют за 5) лучше -M2 (нас матуют за 2)
    expect(Math.sign(evalCompare(mate(1, -5, 'a'), mate(2, -2, 'b')))).toBe(-1);
  });
});

describe('sortLines', () => {
  const lines: EvalLine[] = [
    cp(1, 40, 'e2e4 e7e5'),
    cp(2, 25, 'd2d4 d7d5'),
    cp(3, 10, 'g1f3 g8f6'),
    cp(4, 5, 'c2c4 e7e6'),
    cp(5, -5, 'b2b3 e7e5'),
  ];

  it('stockfish: сохраняет порядок Stockfish (он уже отсортирован по eval+multipv)', () => {
    const noProb = () => undefined;
    const out = sortLines(lines, 'stockfish', noProb);
    expect(out.map((l) => l.multipv)).toEqual([1, 2, 3, 4, 5]);
  });

  it('stockfish с равными eval: tiebreak по multipv asc', () => {
    const tied: EvalLine[] = [
      cp(3, 50, 'a'),
      cp(1, 50, 'b'),
      cp(2, 50, 'c'),
    ];
    const out = sortLines(tied, 'stockfish', () => undefined);
    expect(out.map((l) => l.multipv)).toEqual([1, 2, 3]);
  });

  it('maia: prob desc, undefined → конец', () => {
    const probs: Record<string, number> = {
      'e2e4': 0.10,
      'd2d4': 0.50, // самый частый ход людей
      'g1f3': 0.25,
      // 'c2c4' → undefined (Maia не вернула)
      'b2b3': 0.05,
    };
    const out = sortLines(lines, 'maia', (uci) => probs[uci]);
    // По prob: d2d4 (50) > g1f3 (25) > e2e4 (10) > b2b3 (5) > c2c4 (undefined)
    expect(out.map((l) => l.multipv)).toEqual([2, 3, 1, 5, 4]);
  });

  it('maia: все prob undefined → результат как stockfish (через eval tiebreak)', () => {
    const out = sortLines(lines, 'maia', () => undefined);
    expect(out.map((l) => l.multipv)).toEqual([1, 2, 3, 4, 5]);
  });

  it('maia: равные prob → tiebreak по eval desc, затем multipv', () => {
    const tied: EvalLine[] = [
      cp(3, 10, 'a1'),
      cp(1, 50, 'a2'),
      cp(2, 30, 'a3'),
    ];
    const out = sortLines(tied, 'maia', () => 0.3);
    expect(out.map((l) => l.multipv)).toEqual([1, 2, 3]);
  });

  it('mate-линии корректно перемежаются с cp при stockfish', () => {
    const mixed: EvalLine[] = [
      cp(1, 200, 'a'),
      mate(2, 4, 'b'),
      cp(3, 100, 'c'),
      mate(4, -3, 'd'),
    ];
    const out = sortLines(mixed, 'stockfish', () => undefined);
    expect(out.map((l) => l.multipv)).toEqual([2, 1, 3, 4]);
  });

  it('не мутирует исходный массив', () => {
    const input: EvalLine[] = [cp(2, 10, 'a'), cp(1, 50, 'b')];
    const before = input.map((l) => l.multipv);
    sortLines(input, 'maia', () => 0.5);
    expect(input.map((l) => l.multipv)).toEqual(before);
  });
});
