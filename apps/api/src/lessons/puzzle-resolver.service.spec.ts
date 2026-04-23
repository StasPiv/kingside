import { NotFoundException } from '@nestjs/common';
import type { PuzzleStepPayload } from '@kingside/shared';
import { LessonPuzzleResolverService } from './puzzle-resolver.service';
import { PuzzleService } from '../puzzle/puzzle.service';

describe('LessonPuzzleResolverService', () => {
  let resolver: LessonPuzzleResolverService;
  let puzzleService: jest.Mocked<PuzzleService>;

  beforeEach(() => {
    puzzleService = {
      findPuzzles: jest.fn(),
      getPuzzle: jest.fn(),
    } as unknown as jest.Mocked<PuzzleService>;
    resolver = new LessonPuzzleResolverService(puzzleService);
  });

  describe("mode='ids'", () => {
    it('получает каждый puzzle по id', async () => {
      puzzleService.getPuzzle.mockImplementation(async (id: string) =>
        ({ id, rating: 1400 } as any),
      );
      const payload: PuzzleStepPayload = {
        type: 'puzzle',
        selection: { mode: 'ids', puzzleIds: ['a', 'b', 'c'] },
      };
      const res = await resolver.resolve(payload);
      expect(res.map((p) => p.id)).toEqual(['a', 'b', 'c']);
      expect(puzzleService.getPuzzle).toHaveBeenCalledTimes(3);
    });

    it('кидает NotFoundException если один id отсутствует', async () => {
      puzzleService.getPuzzle.mockImplementationOnce(async () => ({ id: 'a' } as any));
      puzzleService.getPuzzle.mockImplementationOnce(async () => {
        throw new NotFoundException('not found');
      });
      const payload: PuzzleStepPayload = {
        type: 'puzzle',
        selection: { mode: 'ids', puzzleIds: ['a', 'b'] },
      };
      await expect(resolver.resolve(payload)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("mode='filter'", () => {
    it('вызывает findPuzzles с темами, рейтингом, limit и random-ordering по умолчанию', async () => {
      puzzleService.findPuzzles.mockResolvedValue([{ id: 'p1' } as any]);
      const payload: PuzzleStepPayload = {
        type: 'puzzle',
        selection: {
          mode: 'filter',
          themes: ['fork', 'pin'],
          ratingMin: 1200,
          ratingMax: 1500,
          limit: 5,
        },
      };
      const res = await resolver.resolve(payload);
      expect(res).toHaveLength(1);
      expect(puzzleService.findPuzzles).toHaveBeenCalledWith(
        expect.objectContaining({
          themes: ['fork', 'pin'],
          ratingMin: 1200,
          ratingMax: 1500,
          limit: 5,
          // KS-1783: source больше не имеет дефолта 'lichess' —
          // до импорта реальной lichess-базы ограничение давало пустой список.
          source: undefined,
          orderBy: 'random', // KS-1776: дефолт
        }),
      );
    });

    it('прокидывает excludeIds и позволяет переопределить source/orderBy', async () => {
      puzzleService.findPuzzles.mockResolvedValue([]);
      const payload: PuzzleStepPayload = {
        type: 'puzzle',
        selection: { mode: 'filter', themes: ['mate'], limit: 3 },
      };
      await resolver.resolve(payload, {
        excludeIds: ['x', 'y'],
        source: 'generated',
        orderBy: 'rating',
      });
      expect(puzzleService.findPuzzles).toHaveBeenCalledWith(
        expect.objectContaining({
          excludeIds: ['x', 'y'],
          source: 'generated',
          themes: ['mate'],
          limit: 3,
          orderBy: 'rating',
        }),
      );
    });
  });
});
