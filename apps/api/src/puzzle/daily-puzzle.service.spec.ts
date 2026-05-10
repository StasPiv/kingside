jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { NotFoundException } from '@nestjs/common';
import { DailyPuzzleService } from './daily-puzzle.service';

describe('DailyPuzzleService', () => {
  let service: DailyPuzzleService;
  let prisma: any;

  const mockPuzzle = {
    id: 'puzzle-1',
    fen: 'r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2',
    moves: 'e2e4 e7e5',
    rating: 1500,
    ratingDev: 100,
    themes: 'fork pin',
  };

  const mockDaily = {
    id: 'daily-1',
    date: new Date('2026-03-08T00:00:00.000Z'),
    puzzleId: mockPuzzle.id,
    puzzle: mockPuzzle,
  };

  beforeEach(() => {
    prisma = {
      dailyPuzzle: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
      puzzle: {
        findFirst: jest.fn(),
        count: jest.fn(),
      },
    };

    service = new DailyPuzzleService(prisma);
  });

  describe('getDailyPuzzle', () => {
    it('should return existing daily puzzle', async () => {
      prisma.dailyPuzzle.findUnique.mockResolvedValue(mockDaily);

      const result = await service.getDailyPuzzle(new Date('2026-03-08'));

      expect(result.puzzle.id).toBe('puzzle-1');
      expect(result.date).toBe(mockDaily.date);
    });

    it('should create daily puzzle when none exists for date', async () => {
      prisma.dailyPuzzle.findUnique.mockResolvedValue(null);
      prisma.dailyPuzzle.findMany.mockResolvedValue([]);
      prisma.puzzle.count.mockResolvedValue(10);
      prisma.puzzle.findFirst.mockResolvedValue(mockPuzzle);
      prisma.dailyPuzzle.create.mockResolvedValue(mockDaily);

      const result = await service.getDailyPuzzle(new Date('2026-03-08'));

      expect(result.puzzle.id).toBe('puzzle-1');
      expect(prisma.dailyPuzzle.create).toHaveBeenCalled();
    });

    it('should throw NotFoundException when no puzzles available', async () => {
      prisma.dailyPuzzle.findUnique.mockResolvedValue(null);
      prisma.dailyPuzzle.findMany.mockResolvedValue([]);
      prisma.puzzle.count.mockResolvedValue(0);
      prisma.puzzle.findFirst.mockResolvedValue(null);

      await expect(service.getDailyPuzzle(new Date('2026-03-08'))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should select high-difficulty puzzle (rating >= 2000)', async () => {
      prisma.dailyPuzzle.findUnique.mockResolvedValue(null);
      prisma.dailyPuzzle.findMany.mockResolvedValue([]);
      prisma.puzzle.count.mockResolvedValue(5);
      prisma.puzzle.findFirst.mockResolvedValue(mockPuzzle);
      prisma.dailyPuzzle.create.mockResolvedValue(mockDaily);

      await service.getDailyPuzzle(new Date('2026-03-08'));

      expect(prisma.puzzle.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            rating: { gte: 2000 },
          }),
        }),
      );
    });

    it('should exclude already used puzzles', async () => {
      prisma.dailyPuzzle.findUnique.mockResolvedValue(null);
      prisma.dailyPuzzle.findMany.mockResolvedValue([
        { puzzleId: 'used-1' },
        { puzzleId: 'used-2' },
      ]);
      prisma.puzzle.count.mockResolvedValue(3);
      prisma.puzzle.findFirst.mockResolvedValue(mockPuzzle);
      prisma.dailyPuzzle.create.mockResolvedValue(mockDaily);

      await service.getDailyPuzzle(new Date('2026-03-08'));

      expect(prisma.puzzle.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: ['used-1', 'used-2'] },
          }),
        }),
      );
    });

    // ── KS-2716 / ADR-055 B5. Filter solution_mode='forced-line' ─────

    it('KS-2716: фильтрует solution_mode=forced-line при выборе пазла', async () => {
      prisma.dailyPuzzle.findUnique.mockResolvedValue(null);
      prisma.dailyPuzzle.findMany.mockResolvedValue([]);
      prisma.puzzle.count.mockResolvedValue(7);
      prisma.puzzle.findFirst.mockResolvedValue(mockPuzzle);
      prisma.dailyPuzzle.create.mockResolvedValue(mockDaily);

      await service.getDailyPuzzle(new Date('2026-03-08'));

      expect(prisma.puzzle.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            solutionMode: 'forced-line',
          }),
        }),
      );
      expect(prisma.puzzle.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            solutionMode: 'forced-line',
          }),
        }),
      );
    });

    it('KS-2716: fallback (totalAvailable=0) тоже фильтрует forced-line', async () => {
      prisma.dailyPuzzle.findUnique.mockResolvedValue(null);
      prisma.dailyPuzzle.findMany.mockResolvedValue([]);
      prisma.puzzle.count.mockResolvedValue(0);
      prisma.puzzle.findFirst.mockResolvedValue(mockPuzzle);
      prisma.dailyPuzzle.create.mockResolvedValue(mockDaily);

      await service.getDailyPuzzle(new Date('2026-03-08'));

      // Fallback ветка: findFirst без excludeIds, всё равно с
      // solutionMode='forced-line'.
      expect(prisma.puzzle.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            solutionMode: 'forced-line',
          }),
        }),
      );
    });

    it('should produce deterministic puzzle selection for same date', async () => {
      // Same date should always produce the same skip offset
      prisma.dailyPuzzle.findUnique.mockResolvedValue(null);
      prisma.dailyPuzzle.findMany.mockResolvedValue([]);
      prisma.puzzle.count.mockResolvedValue(100);
      prisma.puzzle.findFirst.mockResolvedValue(mockPuzzle);
      prisma.dailyPuzzle.create.mockResolvedValue(mockDaily);

      await service.getDailyPuzzle(new Date('2026-03-08'));
      const call1 = prisma.puzzle.findFirst.mock.calls[0][0].skip;

      prisma.puzzle.findFirst.mockClear();
      prisma.dailyPuzzle.findUnique.mockResolvedValue(null);
      prisma.puzzle.count.mockResolvedValue(100);
      prisma.puzzle.findFirst.mockResolvedValue(mockPuzzle);
      prisma.dailyPuzzle.create.mockResolvedValue(mockDaily);

      await service.getDailyPuzzle(new Date('2026-03-08'));
      const call2 = prisma.puzzle.findFirst.mock.calls[0][0].skip;

      expect(call1).toBe(call2);
    });
  });
});
