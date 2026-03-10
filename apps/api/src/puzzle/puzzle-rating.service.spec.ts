jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { PuzzleRatingService } from './puzzle-rating.service';

describe('PuzzleRatingService', () => {
  let service: PuzzleRatingService;
  let prisma: any;

  const userId = '11111111-1111-4111-a111-111111111111';
  const puzzleId = '22222222-2222-4222-a222-222222222222';

  beforeEach(() => {
    prisma = {
      user: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      puzzle: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
    };

    service = new PuzzleRatingService(prisma);
  });

  it('should increase user rating on solve', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
      rating: 1500,
      ratingDev: 350,
    });

    const result = await service.applyRatingChange(userId, puzzleId, true);

    expect(result.userRatingAfter).toBeGreaterThan(result.userRatingBefore);
    expect(result.userRatingBefore).toBe(1500);
  });

  it('should decrease user rating on fail', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
      rating: 1500,
      ratingDev: 350,
    });

    const result = await service.applyRatingChange(userId, puzzleId, false);

    expect(result.userRatingAfter).toBeLessThan(result.userRatingBefore);
  });

  it('should give more points for solving harder puzzles', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
      rating: 1800,
      ratingDev: 100,
    });

    const hard = await service.applyRatingChange(userId, puzzleId, true);

    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
      rating: 1200,
      ratingDev: 100,
    });

    const easy = await service.applyRatingChange(userId, puzzleId, true);

    expect(hard.userRatingAfter - hard.userRatingBefore).toBeGreaterThan(
      easy.userRatingAfter - easy.userRatingBefore,
    );
  });

  it('should update both user and puzzle in DB', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
      rating: 1500,
      ratingDev: 350,
    });

    await service.applyRatingChange(userId, puzzleId, true);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { ratingPuzzle: expect.any(Number) },
    });
    expect(prisma.puzzle.update).toHaveBeenCalledWith({
      where: { id: puzzleId },
      data: { rating: expect.any(Number) },
    });
  });

  it('should adjust puzzle rating inversely', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
      rating: 1500,
      ratingDev: 350,
    });

    const result = await service.applyRatingChange(userId, puzzleId, true);

    // When user solves, puzzle rating should decrease (puzzle "lost")
    expect(result.puzzleRatingAfter).toBeLessThan(result.puzzleRatingBefore);
  });

  it('should use equal ratings formula correctly', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
      rating: 1500,
      ratingDev: 350,
    });

    const result = await service.applyRatingChange(userId, puzzleId, true);

    // With equal ratings, expected = 0.5, score = 1
    // Change = K * (1 - 0.5) = 32 * 0.5 = 16
    expect(result.userRatingAfter).toBe(1516);
  });
});
