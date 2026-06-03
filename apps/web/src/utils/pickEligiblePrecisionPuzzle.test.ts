/**
 * KS-3634 / KS-3642 / ADR-106 §2.6. Тесты `pickEligiblePrecisionPuzzle`
 * — retry до 5 и fallback после исчерпания, с инвертированной семантикой
 * Maia-фильтра (`maiaWeakChoiceProb >= threshold` при актуальной
 * `maiaMetricVersion`).
 */
import { describe, it, expect, vi } from 'vitest';

import type {
  PickNextPrecisionRequest,
  PickNextPrecisionResponse,
  PuzzleDto,
} from '@kingside/shared';

import { pickEligiblePrecisionPuzzle } from './pickEligiblePrecisionPuzzle';
import { MAIA_METRIC_VERSION } from '../config/precisionMaiaThreshold';

function puzzle(
  id: string,
  prob: number | null | undefined,
  version: number | null = MAIA_METRIC_VERSION,
): PuzzleDto {
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
    maiaWeakChoiceProb: prob,
    maiaMetricVersion: version,
  } as unknown as PuzzleDto;
}

function pickRes(id: string): PickNextPrecisionResponse {
  return { puzzleId: id, rating: 1500, ratingDelta: 0 };
}

const PARAMS: PickNextPrecisionRequest = {
  scope: 'server',
};

describe('pickEligiblePrecisionPuzzle', () => {
  it('первая итерация — eligible (prob >= threshold) → отдаём, getById вызван 1 раз', async () => {
    const pickNext = vi.fn().mockResolvedValue(pickRes('p1'));
    const getPuzzleById = vi.fn().mockResolvedValue(puzzle('p1', 0.7));

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

  it('4 неподходящих (prob < threshold) + 5-й подходящий → отдаём 5-й, attempts=5', async () => {
    const probs = [0.1, 0.2, 0.3, 0.4, 0.7];
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
    const probs = [0.1, 0.15, 0.2, 0.25, 0.3];
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
    const probs = [0.1, 0.2];
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

  it('null maiaWeakChoiceProb (safe fallback) считается eligible с первой итерации', async () => {
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

  it('устаревшая maiaMetricVersion → eligible (значение не валидно для нового фильтра)', async () => {
    // prob ниже порога, но версия не совпадает с MAIA_METRIC_VERSION —
    // пазл должен пройти как «не размечен».
    const pickNext = vi.fn().mockResolvedValue(pickRes('p1'));
    const getPuzzleById = vi
      .fn()
      .mockResolvedValue(puzzle('p1', 0.1, MAIA_METRIC_VERSION + 1));

    const out = await pickEligiblePrecisionPuzzle(
      PARAMS,
      { threshold: 0.5 },
      { pickNext, getPuzzleById },
    );

    expect(out!.eligible).toBe(true);
    expect(out!.attempts).toBe(1);
  });

  it('кастомный maxRetries=2', async () => {
    const probs = [0.1, 0.1, 0.1];
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
