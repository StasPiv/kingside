jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { PuzzleRatingService } from './puzzle-rating.service';
import { GlickoRatingService } from './glicko-rating.service';

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
      puzzleRatingSnapshot: {
        upsert: jest.fn(),
      },
    };

    service = new PuzzleRatingService(prisma, new GlickoRatingService());
  });

  it('should increase user rating on solve', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500, ratingPuzzleDev: 350, puzzleStreak: 0 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1500, ratingDev: 350 });

    const result = await service.applyRatingChange(userId, puzzleId, true);

    expect(result.userRatingAfter).toBeGreaterThan(result.userRatingBefore);
    expect(result.userRatingBefore).toBe(1500);
  });

  it('should decrease user rating on fail', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500, ratingPuzzleDev: 350, puzzleStreak: 0 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1500, ratingDev: 350 });

    const result = await service.applyRatingChange(userId, puzzleId, false);

    expect(result.userRatingAfter).toBeLessThan(result.userRatingBefore);
  });

  it('should adjust puzzle rating inversely', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500, ratingPuzzleDev: 350, puzzleStreak: 0 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1500, ratingDev: 350 });

    const result = await service.applyRatingChange(userId, puzzleId, true);

    expect(result.puzzleRatingAfter).toBeLessThan(result.puzzleRatingBefore);
  });

  it('should update streak on solve', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500, ratingPuzzleDev: 350, puzzleStreak: 3 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1500, ratingDev: 350 });

    await service.applyRatingChange(userId, puzzleId, true);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ puzzleStreak: 4 }),
      }),
    );
  });

  it('should reset streak on fail', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500, ratingPuzzleDev: 350, puzzleStreak: 5 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1500, ratingDev: 350 });

    await service.applyRatingChange(userId, puzzleId, false);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ puzzleStreak: 0 }),
      }),
    );
  });

  it('should upsert daily snapshot', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ratingPuzzle: 1500, ratingPuzzleDev: 350, puzzleStreak: 0 });
    prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1500, ratingDev: 350 });

    await service.applyRatingChange(userId, puzzleId, true);

    expect(prisma.puzzleRatingSnapshot.upsert).toHaveBeenCalled();
  });

  // ── KS-2716 / ADR-055 B2. Skip PVE ─────────────────────────────────

  describe('play-vs-engine: skip rating/streak/snapshot', () => {
    beforeEach(() => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ratingPuzzle: 1500,
        ratingPuzzleDev: 350,
        puzzleStreak: 7,
      });
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({
        rating: 1800,
        ratingDev: 200,
        solutionMode: 'play-vs-engine',
      });
    });

    it('возвращает «нулевую дельту» — rating до = после', async () => {
      const result = await service.applyRatingChange(userId, puzzleId, true);
      expect(result.userRatingBefore).toBe(1500);
      expect(result.userRatingAfter).toBe(1500);
      expect(result.puzzleRatingBefore).toBe(1800);
      expect(result.puzzleRatingAfter).toBe(1800);
    });

    it('не пишет user.update / puzzle.update / snapshot.upsert', async () => {
      await service.applyRatingChange(userId, puzzleId, true);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.puzzle.update).not.toHaveBeenCalled();
      expect(prisma.puzzleRatingSnapshot.upsert).not.toHaveBeenCalled();
    });

    it('streak не обнуляется при PVE-fail', async () => {
      await service.applyRatingChange(userId, puzzleId, false);
      // user.update не вызывался — значит puzzleStreak в БД остался 7.
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
