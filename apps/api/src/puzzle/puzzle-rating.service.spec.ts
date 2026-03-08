<<<<<<< HEAD
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

=======
>>>>>>> feature/KS-140
import { PuzzleRatingService } from './puzzle-rating.service';

describe('PuzzleRatingService', () => {
  let service: PuzzleRatingService;
<<<<<<< HEAD
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
      ratingDeviation: 350,
    });

    const result = await service.applyRatingChange(userId, puzzleId, true);

    expect(result.userRatingAfter).toBeGreaterThan(result.userRatingBefore);
    expect(result.userRatingBefore).toBe(1500);
  });

  it('should decrease user rating on fail', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
      rating: 1500,
      ratingDeviation: 350,
    });

    const result = await service.applyRatingChange(userId, puzzleId, false);

    expect(result.userRatingAfter).toBeLessThan(result.userRatingBefore);
  });

  it('should give more points for solving harder puzzles', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
      rating: 1800,
      ratingDeviation: 100,
    });

    const hard = await service.applyRatingChange(userId, puzzleId, true);

    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
      rating: 1200,
      ratingDeviation: 100,
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
      ratingDeviation: 350,
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
      ratingDeviation: 350,
    });

    const result = await service.applyRatingChange(userId, puzzleId, true);

    // When user solves, puzzle rating should decrease (puzzle "lost")
    expect(result.puzzleRatingAfter).toBeLessThan(result.puzzleRatingBefore);
  });

  it('should use equal ratings formula correctly', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
      rating: 1500,
      ratingDeviation: 350,
    });

    const result = await service.applyRatingChange(userId, puzzleId, true);

    // With equal ratings, expected = 0.5, score = 1
    // Change = K * (1 - 0.5) = 32 * 0.5 = 16
    expect(result.userRatingAfter).toBe(1516);
=======

  beforeEach(() => {
    service = new PuzzleRatingService();
  });

  it('should increase rating when solving a harder puzzle', () => {
    const result = service.calculateNewRating(1500, 1600, true);
    expect(result).toBeGreaterThan(1500);
  });

  it('should decrease rating when failing an easier puzzle', () => {
    const result = service.calculateNewRating(1500, 1400, false);
    expect(result).toBeLessThan(1500);
  });

  it('should increase rating less when solving an easier puzzle', () => {
    const hardSolve = service.calculateNewRating(1500, 1700, true);
    const easySolve = service.calculateNewRating(1500, 1300, true);
    expect(hardSolve - 1500).toBeGreaterThan(easySolve - 1500);
  });

  it('should not go below 100', () => {
    const result = service.calculateNewRating(100, 2000, false);
    expect(result).toBeGreaterThanOrEqual(100);
  });

  it('should give ~16 points for equal rating solved', () => {
    const result = service.calculateNewRating(1500, 1500, true);
    expect(result).toBe(1516);
  });

  it('should lose ~16 points for equal rating failed', () => {
    const result = service.calculateNewRating(1500, 1500, false);
    expect(result).toBe(1484);
>>>>>>> feature/KS-140
  });
});
