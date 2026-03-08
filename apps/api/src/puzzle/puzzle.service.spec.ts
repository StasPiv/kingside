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
  let ratingService: PuzzleRatingService;

  beforeEach(() => {
    prisma = {
      puzzle: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      puzzleAttempt: {
        create: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
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

    ratingService = new PuzzleRatingService();

    service = new PuzzleService(prisma, i18n, ratingService);
  });

  describe('getPuzzleById', () => {
    it('should return puzzle when found', async () => {
      const puzzle = { id: 'abc123', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', rating: 1500 };
      prisma.puzzle.findUnique.mockResolvedValue(puzzle);

      const result = await service.getPuzzleById('abc123');
      expect(result).toEqual(puzzle);
    });

    it('should throw NotFoundException when puzzle not found', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(null);

      await expect(service.getPuzzleById('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('submitAttempt', () => {
    it('should create attempt and update rating on solve', async () => {
      const puzzle = { id: 'abc123', rating: 1500 };
      const user = { ratingPuzzle: 1500 };
      const attempt = { id: 'attempt-1', puzzleId: 'abc123', userId: 'user-1', solved: true, ratingBefore: 1500, ratingAfter: 1516 };

      prisma.puzzle.findUnique.mockResolvedValue(puzzle);
      prisma.user.findUniqueOrThrow.mockResolvedValue(user);
      prisma.puzzleAttempt.create.mockResolvedValue(attempt);
      prisma.user.update.mockResolvedValue({});

      const result = await service.submitAttempt('user-1', 'abc123', true);

      expect(result.solved).toBe(true);
      expect(result.ratingAfter).toBeGreaterThan(result.ratingBefore);
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('should throw NotFoundException for non-existent puzzle', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(null);

      await expect(service.submitAttempt('user-1', 'nonexistent', true)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getUserPuzzleStats', () => {
    it('should return stats for user', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1600 });
      prisma.puzzleAttempt.count.mockResolvedValueOnce(100).mockResolvedValueOnce(65);

      const result = await service.getUserPuzzleStats('user-1');

      expect(result.rating).toBe(1600);
      expect(result.totalAttempts).toBe(100);
      expect(result.solved).toBe(65);
      expect(result.failed).toBe(35);
    });

    it('should throw NotFoundException for non-existent user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getUserPuzzleStats('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});
