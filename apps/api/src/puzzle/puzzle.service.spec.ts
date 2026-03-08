import { Test, TestingModule } from '@nestjs/testing';
import { PuzzleService } from './puzzle.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PuzzleService', () => {
  let service: PuzzleService;
  let prisma: {
    puzzle: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
    };
    user: { findUniqueOrThrow: jest.Mock };
    puzzleAttempt: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      puzzle: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
      },
      user: { findUniqueOrThrow: jest.fn() },
      puzzleAttempt: { findMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PuzzleService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<PuzzleService>(PuzzleService);
  });

  describe('findPuzzles', () => {
    it('should return puzzles filtered by rating range', async () => {
      const mockPuzzles = [
        { id: '1', fen: 'fen1', moves: 'e2e4', rating: 1300, ratingDeviation: 100, themes: ['fork'] },
      ];
      prisma.puzzle.findMany.mockResolvedValue(mockPuzzles);

      const result = await service.findPuzzles({ ratingMin: 1200, ratingMax: 1400 });

      expect(result).toEqual(mockPuzzles);
      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rating: { gte: 1200, lte: 1400 } },
        }),
      );
    });

    it('should return puzzles filtered by themes', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ themes: ['fork', 'pin'] });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { themes: { hasEvery: ['fork', 'pin'] } },
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
            themes: { hasEvery: ['mate'] },
          },
        }),
      );
    });
  });

  describe('findPuzzleForUser', () => {
    it('should return null if no puzzles available', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);
      prisma.puzzle.count.mockResolvedValue(0);

      const result = await service.findPuzzleForUser('user-1');

      expect(result).toBeNull();
    });

    it('should exclude already attempted puzzles', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.puzzleAttempt.findMany.mockResolvedValue([
        { puzzleId: 'p1' },
        { puzzleId: 'p2' },
      ]);
      prisma.puzzle.count.mockResolvedValue(1);
      prisma.puzzle.findMany.mockResolvedValue([
        { id: 'p3', fen: 'fen', moves: 'e2e4', rating: 1500, ratingDeviation: 100, themes: [] },
      ]);

      const result = await service.findPuzzleForUser('user-1');

      expect(result).toBeDefined();
      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: ['p1', 'p2'] },
          }),
        }),
      );
    });
  });

  describe('findPuzzleByThemeForUser', () => {
    it('should filter by theme and user rating', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1200 });
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);
      prisma.puzzle.count.mockResolvedValue(1);
      prisma.puzzle.findMany.mockResolvedValue([
        { id: 'p1', fen: 'fen', moves: 'e2e4', rating: 1200, ratingDeviation: 100, themes: ['fork'] },
      ]);

      const result = await service.findPuzzleByThemeForUser('user-1', 'fork');

      expect(result).toBeDefined();
      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            themes: { has: 'fork' },
            rating: { gte: 1000, lte: 1400 },
          }),
        }),
      );
    });
  });

  describe('getPuzzleById', () => {
    it('should return puzzle by id', async () => {
      const mockPuzzle = { id: 'p1', fen: 'fen', moves: 'e2e4', rating: 1500, ratingDeviation: 100, themes: [] };
      prisma.puzzle.findUnique.mockResolvedValue(mockPuzzle);

      const result = await service.getPuzzleById('p1');

      expect(result).toEqual(mockPuzzle);
    });

    it('should return null for non-existent puzzle', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(null);

      const result = await service.getPuzzleById('non-existent');

      expect(result).toBeNull();
    });
  });
});
