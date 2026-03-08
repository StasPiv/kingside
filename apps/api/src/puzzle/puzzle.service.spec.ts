import { NotFoundException } from '@nestjs/common';
import { PuzzleService } from './puzzle.service';
import { PuzzleRatingService } from './puzzle-rating.service';

jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

describe('PuzzleService', () => {
  let service: PuzzleService;
  let prisma: any;
  let i18n: any;
  let ratingService: any;

  beforeEach(() => {
    prisma = {
      puzzle: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      puzzleAttempt: {
        create: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
      puzzleRushScore: {
        findFirst: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
    } as any;

    i18n = {
      t: jest.fn((key: string) => key),
    };

    ratingService = {
      applyRatingChange: jest.fn(),
    };

    service = new PuzzleService(prisma, i18n, ratingService);
  });

  describe('findPuzzles', () => {
    it('should return puzzles filtered by rating range', async () => {
      const mockPuzzles = [
        { id: '1', fen: 'fen1', moves: 'e2e4 e7e5', rating: 1300, themes: 'fork pin' },
      ];
      prisma.puzzle.findMany.mockResolvedValue(mockPuzzles);

      const result = await service.findPuzzles({ ratingMin: 1200, ratingMax: 1400 });

      expect(result).toHaveLength(1);
      expect(result[0].rating).toBe(1300);
      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rating: { gte: 1200, lte: 1400 } },
        }),
      );
    });

    it('should filter by themes using contains', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ themes: ['fork', 'pin'] });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { themes: { contains: 'fork' } },
              { themes: { contains: 'pin' } },
            ],
          },
        }),
      );
    });

    it('should use default limit of 10', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({});

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });

    it('should respect custom limit', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ limit: 5 });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it('should combine theme and rating filters', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ themes: ['mate'], ratingMin: 1000, ratingMax: 1500 });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            rating: { gte: 1000, lte: 1500 },
            AND: [{ themes: { contains: 'mate' } }],
          },
        }),
      );
    });
  });

  describe('getNextPuzzleByTheme', () => {
    it('should filter by theme and user rating range', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1200 });
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);
      prisma.puzzle.findMany.mockResolvedValue([
        { id: 'p1', fen: 'fen', moves: 'e2e4', rating: 1200, themes: 'fork' },
      ]);

      const result = await service.getNextPuzzleByTheme('user-1', 'fork');

      expect(result).toBeDefined();
      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            themes: { contains: 'fork' },
            rating: { gte: 1000, lte: 1400 },
          }),
        }),
      );
    });

    it('should throw NotFoundException when no puzzles for theme', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);
      prisma.puzzle.findMany.mockResolvedValue([]);

      await expect(service.getNextPuzzleByTheme('user-1', 'zugzwang')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should exclude only solved puzzles', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.puzzleAttempt.findMany.mockResolvedValue([
        { puzzleId: 'p1' },
        { puzzleId: 'p2' },
      ]);
      prisma.puzzle.findMany.mockResolvedValue([
        { id: 'p3', fen: 'fen', moves: 'e2e4', rating: 1500, themes: 'fork' },
      ]);

      await service.getNextPuzzleByTheme('user-1', 'fork');

      expect(prisma.puzzleAttempt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', solved: true },
        }),
      );
      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: ['p1', 'p2'] },
          }),
        }),
      );
    });
  });

  describe('getPuzzle', () => {
    it('should return formatted puzzle when found', async () => {
      const puzzle = { id: 'abc123', fen: 'fen1', moves: 'e2e4 e7e5', rating: 1500, themes: 'fork pin' };
      prisma.puzzle.findUnique.mockResolvedValue(puzzle);

      const result = await service.getPuzzle('abc123');
      expect(result.id).toBe('abc123');
      expect(result.moves).toEqual(['e2e4', 'e7e5']);
      expect(result.themes).toEqual(['fork', 'pin']);
    });

    it('should throw NotFoundException when puzzle not found', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(null);

      await expect(service.getPuzzle('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});
