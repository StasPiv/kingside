jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { RatingService } from './rating.service';

describe('RatingService', () => {
  let service: RatingService;
  let prisma: any;

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

    service = new RatingService(prisma);
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

  function setupRatings(
    whiteRating: number,
    blackRating: number,
    field = 'ratingBlitz',
    whiteGamesPlayed = 30,
    blackGamesPlayed = 30,
    gamesPlayedField = 'gamesPlayedBlitz',
  ) {
    prisma.user.findUniqueOrThrow
      .mockResolvedValueOnce({ [field]: whiteRating, [gamesPlayedField]: whiteGamesPlayed })
      .mockResolvedValueOnce({ [field]: blackRating, [gamesPlayedField]: blackGamesPlayed });
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

    it('should give equal rating change for equal-rated established players', async () => {
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

    it('should increment gamesPlayed counter', async () => {
      setupGame();
      setupRatings(1500, 1500);

      await service.updateRatingsAfterGame(gameId, 'white');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );
      const blackUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === blackId,
      );

      expect(whiteUpdate[0].data.gamesPlayedBlitz).toEqual({ increment: 1 });
      expect(blackUpdate[0].data.gamesPlayedBlitz).toEqual({ increment: 1 });
    });
  });

  describe('provisional rating', () => {
    it('should use K=40 for provisional players (< 20 games)', async () => {
      setupGame();
      setupRatings(1500, 1500, 'ratingBlitz', 5, 5);

      await service.updateRatingsAfterGame(gameId, 'white');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );
      const blackUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === blackId,
      );

      // K=40, expected=0.5, score=1 => +20
      expect(whiteUpdate[0].data.ratingBlitz).toBe(1520);
      expect(blackUpdate[0].data.ratingBlitz).toBe(1480);
    });

    it('should use K=32 for established players (>= 20 games)', async () => {
      setupGame();
      setupRatings(1500, 1500, 'ratingBlitz', 20, 20);

      await service.updateRatingsAfterGame(gameId, 'white');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );

      // K=32, expected=0.5, score=1 => +16
      expect(whiteUpdate[0].data.ratingBlitz).toBe(1516);
    });

    it('should use different K-factors when one player is provisional and other is established', async () => {
      setupGame();
      setupRatings(1500, 1500, 'ratingBlitz', 5, 30);

      await service.updateRatingsAfterGame(gameId, 'white');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );
      const blackUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === blackId,
      );

      // White: K=40 (provisional), expected=0.5 => +20
      expect(whiteUpdate[0].data.ratingBlitz).toBe(1520);
      // Black: K=32 (established), expected=0.5 => -16
      expect(blackUpdate[0].data.ratingBlitz).toBe(1484);
    });

    it('should use K=40 for player at boundary (19 games)', async () => {
      setupGame();
      setupRatings(1500, 1500, 'ratingBlitz', 19, 30);

      await service.updateRatingsAfterGame(gameId, 'white');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );

      // K=40 (still provisional at 19 games)
      expect(whiteUpdate[0].data.ratingBlitz).toBe(1520);
    });
  });

  describe('time control mapping', () => {
    it.each([
      ['bullet', 'ratingBullet', 'gamesPlayedBullet'],
      ['blitz', 'ratingBlitz', 'gamesPlayedBlitz'],
      ['rapid', 'ratingRapid', 'gamesPlayedRapid'],
      ['classical', 'ratingClassical', 'gamesPlayedClassical'],
    ])('should use %s fields for %s time control', async (type, ratingField, gpField) => {
      setupGame({ timeControlType: type });
      setupRatings(1500, 1500, ratingField, 30, 30, gpField);

      await service.updateRatingsAfterGame(gameId, 'draw');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );
      expect(whiteUpdate[0].data).toHaveProperty(ratingField);
      expect(whiteUpdate[0].data).toHaveProperty(gpField);
    });

    it('should default to blitz for unknown type', async () => {
      setupGame({ timeControlType: 'unknown' });
      setupRatings(1500, 1500);

      await service.updateRatingsAfterGame(gameId, 'draw');

      const whiteUpdate = prisma.user.update.mock.calls.find(
        (c: any) => c[0].where.id === whiteId,
      );
      expect(whiteUpdate[0].data).toHaveProperty('ratingBlitz');
      expect(whiteUpdate[0].data).toHaveProperty('gamesPlayedBlitz');
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
});
