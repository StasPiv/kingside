jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { RatingService } from './rating.service';

describe('RatingService', () => {
  let service: RatingService;
  let prisma: any;
  let protection: any;

  const gameId = 'game-001';
  const whiteId = 'white-player';
  const blackId = 'black-player';

  beforeEach(() => {
    prisma = {
      game: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
      user: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };

    protection = {
      validateGame: jest.fn().mockResolvedValue({ allowed: true }),
    };

    service = new RatingService(prisma, protection);
  });

  function setupGame(overrides: any = {}) {
    prisma.game.findUniqueOrThrow.mockResolvedValue({
      whiteId,
      blackId,
      timeControlType: 'blitz',
      isBot: false,
      ...overrides,
    });
  }

  function setupRatings(whiteRating: number, blackRating: number, field = 'ratingBlitz') {
    prisma.user.findUniqueOrThrow
      .mockResolvedValueOnce({ [field]: whiteRating })
      .mockResolvedValueOnce({ [field]: blackRating });
  }

  describe('ELO calculation', () => {
    it('should increase winner rating and decrease loser rating', async () => {
      setupGame();
      setupRatings(1500, 1500);

      await service.updateRatingsAfterGame(gameId, 'white');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );
      const blackUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === blackId,
      );

      expect(whiteUpdate[0].data.ratingBlitz).toBeGreaterThan(1500);
      expect(blackUpdate[0].data.ratingBlitz).toBeLessThan(1500);
    });

    it('should give equal rating change for equal-rated players', async () => {
      setupGame();
      setupRatings(1500, 1500);

      await service.updateRatingsAfterGame(gameId, 'white');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );
      const blackUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === blackId,
      );

      // K=32, expected=0.5, score=1 => +16
      expect(whiteUpdate[0].data.ratingBlitz).toBe(1516);
      expect(blackUpdate[0].data.ratingBlitz).toBe(1484);
    });

    it('should handle draw result', async () => {
      setupGame();
      setupRatings(1500, 1500);

      await service.updateRatingsAfterGame(gameId, 'draw');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );

      // Equal ratings, draw => no change
      expect(whiteUpdate[0].data.ratingBlitz).toBe(1500);
    });

    it('should give more points for upset wins', async () => {
      setupGame();
      setupRatings(1200, 1800);

      await service.updateRatingsAfterGame(gameId, 'white');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );

      // Upset win should give close to 32 points
      expect(whiteUpdate[0].data.ratingBlitz).toBeGreaterThan(1228);
    });

    it('should store rating snapshots on game record', async () => {
      setupGame();
      setupRatings(1500, 1600);

      await service.updateRatingsAfterGame(gameId, 'white');

      expect(prisma.game.update).toHaveBeenCalledWith({
        where: { id: gameId },
        data: {
          whiteRatingBefore: 1500,
          blackRatingBefore: 1600,
          whiteRatingAfter: expect.any(Number),
          blackRatingAfter: expect.any(Number),
        },
      });
    });
  });

  describe('time control mapping', () => {
    it.each([
      ['bullet', 'ratingBullet'],
      ['blitz', 'ratingBlitz'],
      ['rapid', 'ratingRapid'],
      ['classical', 'ratingClassical'],
    ])('should use %s field for %s time control', async (type, field) => {
      setupGame({ timeControlType: type });
      setupRatings(1500, 1500, field);

      await service.updateRatingsAfterGame(gameId, 'draw');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );
      expect(whiteUpdate[0].data).toHaveProperty(field);
    });

    it('should default to blitz for unknown type', async () => {
      setupGame({ timeControlType: 'unknown' });
      setupRatings(1500, 1500);

      await service.updateRatingsAfterGame(gameId, 'draw');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );
      expect(whiteUpdate[0].data).toHaveProperty('ratingBlitz');
    });
  });

  describe('bot games', () => {
    it('should skip rating update for bot games', async () => {
      setupGame({ isBot: true });

      await service.updateRatingsAfterGame(gameId, 'white');

      expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('rating protection', () => {
    it('should skip rating update when protection rejects', async () => {
      setupGame();
      protection.validateGame.mockResolvedValue({ allowed: false, reason: 'too few moves' });

      await service.updateRatingsAfterGame(gameId, 'white');

      expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should update ratings when protection allows', async () => {
      setupGame();
      setupRatings(1500, 1500);
      protection.validateGame.mockResolvedValue({ allowed: true });

      await service.updateRatingsAfterGame(gameId, 'white');

      expect(prisma.user.update).toHaveBeenCalled();
    });
  });
});
