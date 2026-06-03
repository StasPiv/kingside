/**
 * KS-3634 / ADR-104 §8. Тесты `pickEligiblePrecisionPuzzle` — retry до 5
 * и fallback после исчерпания.
 */
import { describe, it, expect, vi } from 'vitest';

import type {
  PickNextPrecisionRequest,
  PickNextPrecisionResponse,
  PuzzleDto,
} from '@kingside/shared';

import { pickEligiblePrecisionPuzzle } from './pickEligiblePrecisionPuzzle';

function puzzle(id: string, prob: number | null | undefined): PuzzleDto {
  return {
    id,
    fen: '8/8/8/8/8/8/8/k6K w - - 0 1',
    moves: ['a1b1'],
    themes: [],
    rating: 1500,
    ratingDeviation: 0,
    popularity: 0,
    nbPlays: 0,
    solutionMode: 'forced-line',
    objective: 'all',
    maiaTop1Prob: prob,
  } as unknown as PuzzleDto;
}

function pickRes(id: string): PickNextPrecisionResponse {
  return { puzzleId: id, rating: 1500, ratingDelta: 0 };
}

const PARAMS: PickNextPrecisionRequest = {
  scope: 'server',
};

describe('pickEligiblePrecisionPuzzle', () => {
  it('первая итерация — eligible → отдаём, getById вызван 1 раз', async () => {
    const pickNext = vi.fn().mockResolvedValue(pickRes('p1'));
    const getPuzzleById = vi.fn().mockResolvedValue(puzzle('p1', 0.3));

    const out = await pickEligiblePrecisionPuzzle(
      PARAMS,
      { threshold: 0.5 },
      { pickNext, getPuzzleById },
    );

    expect(out).not.toBeNull();
    expect(out!.puzzleId).toBe('p1');
    expect(out!.eligible).toBe(true);
    expect(out!.attempts).toBe(1);
    expect(pickNext).toHaveBeenCalledTimes(1);
    expect(getPuzzleById).toHaveBeenCalledTimes(1);
  });

  it('4 неподходящих + 5-й подходящий → отдаём 5-й, attempts=5', async () => {
    const probs = [0.9, 0.8, 0.7, 0.6, 0.3];
    let i = 0;
    const pickNext = vi.fn().mockImplementation(async () => pickRes(`p${i + 1}`));
    const getPuzzleById = vi.fn().mockImplementation(async () => {
      const p = puzzle(`p${i + 1}`, probs[i]);
      i++;
      return p;
    });

    const out = await pickEligiblePrecisionPuzzle(
      PARAMS,
      { threshold: 0.5 },
      { pickNext, getPuzzleById },
    );

    expect(out).not.toBeNull();
    expect(out!.puzzleId).toBe('p5');
    expect(out!.eligible).toBe(true);
    expect(out!.attempts).toBe(5);
    expect(pickNext).toHaveBeenCalledTimes(5);
    expect(getPuzzleById).toHaveBeenCalledTimes(5);
  });

  it('5 неподходящих → отдаём последний как fallback, eligible=false, attempts=5', async () => {
    const probs = [0.9, 0.85, 0.8, 0.75, 0.7];
    let i = 0;
    const pickNext = vi.fn().mockImplementation(async () => pickRes(`p${i + 1}`));
    const getPuzzleById = vi.fn().mockImplementation(async () => {
      const p = puzzle(`p${i + 1}`, probs[i]);
      i++;
      return p;
    });

    const out = await pickEligiblePrecisionPuzzle(
      PARAMS,
      { threshold: 0.5 },
      { pickNext, getPuzzleById },
    );

    expect(out).not.toBeNull();
    expect(out!.puzzleId).toBe('p5');
    expect(out!.eligible).toBe(false);
    expect(out!.attempts).toBe(5);
    expect(pickNext).toHaveBeenCalledTimes(5);
  });

  it('backend сразу вернул `puzzleId: null` → возвращаем null без повторов', async () => {
    const pickNext = vi.fn().mockResolvedValue({
      puzzleId: null,
      reason: 'no_puzzles_available',
    } as PickNextPrecisionResponse);
    const getPuzzleById = vi.fn();

    const out = await pickEligiblePrecisionPuzzle(
      PARAMS,
      { threshold: 0.5 },
      { pickNext, getPuzzleById },
    );

    expect(out).toBeNull();
    expect(pickNext).toHaveBeenCalledTimes(1);
    expect(getPuzzleById).not.toHaveBeenCalled();
  });

  it('после 2 неподходящих backend вернул null → возвращаем null', async () => {
    const ress: PickNextPrecisionResponse[] = [
      pickRes('p1'),
      pickRes('p2'),
      { puzzleId: null, reason: 'no_puzzles_available' },
    ];
    let i = 0;
    const pickNext = vi.fn().mockImplementation(async () => ress[i++]);
    const probs = [0.9, 0.8];
    let j = 0;
    const getPuzzleById = vi
      .fn()
      .mockImplementation(async (id: string) => puzzle(id, probs[j++]));

    const out = await pickEligiblePrecisionPuzzle(
      PARAMS,
      { threshold: 0.5 },
      { pickNext, getPuzzleById },
    );

    expect(out).toBeNull();
    expect(pickNext).toHaveBeenCalledTimes(3);
    expect(getPuzzleById).toHaveBeenCalledTimes(2);
  });

  it('null maiaTop1Prob (safe fallback) считается eligible с первой итерации', async () => {
    const pickNext = vi.fn().mockResolvedValue(pickRes('p1'));
    const getPuzzleById = vi.fn().mockResolvedValue(puzzle('p1', null));

    const out = await pickEligiblePrecisionPuzzle(
      PARAMS,
      { threshold: 0.5 },
      { pickNext, getPuzzleById },
    );

    expect(out!.eligible).toBe(true);
    expect(out!.attempts).toBe(1);
  });

  it('кастомный maxRetries=2', async () => {
    const probs = [0.9, 0.9, 0.9];
    let i = 0;
    const pickNext = vi.fn().mockImplementation(async () => pickRes(`p${i + 1}`));
    const getPuzzleById = vi.fn().mockImplementation(async () => {
      const p = puzzle(`p${i + 1}`, probs[i]);
      i++;
      return p;
    });

    const out = await pickEligiblePrecisionPuzzle(
      PARAMS,
      { threshold: 0.5, maxRetries: 2 },
      { pickNext, getPuzzleById },
    );

    expect(out!.attempts).toBe(2);
    expect(out!.eligible).toBe(false);
    expect(pickNext).toHaveBeenCalledTimes(2);
  });
});
