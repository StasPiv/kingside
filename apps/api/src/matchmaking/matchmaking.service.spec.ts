jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('../redis/redis.service', () => ({
  RedisService: jest.fn(),
}));
jest.mock('../game/game.service', () => ({
  GameService: jest.fn(),
}));

import { MatchmakingService } from './matchmaking.service';

describe('MatchmakingService', () => {
  let service: MatchmakingService;
  let prisma: any;
  let redis: any;
  let gameService: any;

  const userId = '11111111-1111-4111-a111-111111111111';
  const opponentId = '22222222-2222-4222-a222-222222222222';

  beforeEach(() => {
    prisma = {
      user: {
        findUniqueOrThrow: jest.fn(),
        findUnique: jest.fn(),
      },
      game: {
        create: jest.fn(),
      },
    } as any;

    redis = {
      zrangebyscore: jest.fn().mockResolvedValue([]),
      zadd: jest.fn().mockResolvedValue(1),
      zrange: jest.fn().mockResolvedValue([]),
      zrem: jest.fn().mockResolvedValue(1),
    } as any;

    gameService = {
      initGame: jest.fn().mockResolvedValue(undefined),
    } as any;

    service = new MatchmakingService(redis, gameService, prisma);
  });

  describe('joinQueue', () => {
    beforeEach(() => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: userId,
        ratingBlitz: 1500,
        ratingBullet: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
      });
    });

    it('should add user to queue when no opponent found', async () => {
      const result = await service.joinQueue(userId, 300, 0);

      expect(result).toBeNull();
      expect(redis.zadd).toHaveBeenCalledWith(
        'matchmaking:blitz',
        1500,
        expect.stringContaining(userId),
      );
    });

    it('should match with opponent in rating range', async () => {
      const candidateEntry = JSON.stringify({
        userId: opponentId,
        rating: 1450,
        timeInitialSec: 300,
        timeIncrementSec: 0,
      });

      redis.zrangebyscore.mockResolvedValue([candidateEntry]);
      prisma.game.create.mockResolvedValue({ id: 'game-1' });
      prisma.user.findUnique.mockResolvedValue({
        id: opponentId,
        username: 'opponent',
      });

      const result = await service.joinQueue(userId, 300, 0);

      expect(result).not.toBeNull();
      expect(result!.gameId).toBe('game-1');
      expect(result!.opponent).toEqual({ id: opponentId, username: 'opponent' });
      expect(redis.zrem).toHaveBeenCalled();
      expect(gameService.initGame).toHaveBeenCalledWith('game-1');
    });

    it('should skip own entry in queue', async () => {
      const ownEntry = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 300,
        timeIncrementSec: 0,
      });

      redis.zrangebyscore.mockResolvedValue([ownEntry]);

      const result = await service.joinQueue(userId, 300, 0);

      expect(result).toBeNull();
      expect(redis.zadd).toHaveBeenCalled();
    });

    it('should skip candidate with different time control', async () => {
      const candidateEntry = JSON.stringify({
        userId: opponentId,
        rating: 1500,
        timeInitialSec: 600,
        timeIncrementSec: 0,
      });

      redis.zrangebyscore.mockResolvedValue([candidateEntry]);

      const result = await service.joinQueue(userId, 300, 0);

      expect(result).toBeNull();
    });

    it('should use correct rating field for bullet', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: userId,
        ratingBullet: 1200,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
      });

      await service.joinQueue(userId, 60, 0);

      expect(redis.zadd).toHaveBeenCalledWith(
        'matchmaking:bullet',
        1200,
        expect.any(String),
      );
    });

    it('should use correct rating field for rapid', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: userId,
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1800,
        ratingClassical: 1500,
      });

      await service.joinQueue(userId, 600, 0);

      expect(redis.zadd).toHaveBeenCalledWith(
        'matchmaking:rapid',
        1800,
        expect.any(String),
      );
    });

    describe('rating filter', () => {
      it('should skip candidate outside joiner absolute filter', async () => {
        const candidateEntry = JSON.stringify({
          userId: opponentId,
          rating: 1200,
          timeInitialSec: 300,
          timeIncrementSec: 0,
        });

        redis.zrangebyscore.mockResolvedValue([candidateEntry]);

        const result = await service.joinQueue(
          userId, 300, 0, undefined,
          { minRating: 1400, maxRating: 1600 },
        );

        expect(result).toBeNull();
        expect(redis.zadd).toHaveBeenCalled();
      });

      it('should match candidate inside joiner absolute filter', async () => {
        const candidateEntry = JSON.stringify({
          userId: opponentId,
          rating: 1450,
          timeInitialSec: 300,
          timeIncrementSec: 0,
        });

        redis.zrangebyscore.mockResolvedValue([candidateEntry]);
        prisma.game.create.mockResolvedValue({ id: 'game-1' });
        prisma.user.findUnique.mockResolvedValue({
          id: opponentId,
          username: 'opponent',
        });

        const result = await service.joinQueue(
          userId, 300, 0, undefined,
          { minRating: 1400, maxRating: 1600 },
        );

        expect(result).not.toBeNull();
        expect(result!.gameId).toBe('game-1');
      });

      it('should skip candidate outside joiner ratingDelta filter', async () => {
        const candidateEntry = JSON.stringify({
          userId: opponentId,
          rating: 1350,
          timeInitialSec: 300,
          timeIncrementSec: 0,
        });

        redis.zrangebyscore.mockResolvedValue([candidateEntry]);

        const result = await service.joinQueue(
          userId, 300, 0, undefined,
          { ratingDelta: 100 },
        );

        expect(result).toBeNull();
      });

      it('should match candidate inside joiner ratingDelta filter', async () => {
        const candidateEntry = JSON.stringify({
          userId: opponentId,
          rating: 1450,
          timeInitialSec: 300,
          timeIncrementSec: 0,
        });

        redis.zrangebyscore.mockResolvedValue([candidateEntry]);
        prisma.game.create.mockResolvedValue({ id: 'game-1' });
        prisma.user.findUnique.mockResolvedValue({
          id: opponentId,
          username: 'opponent',
        });

        const result = await service.joinQueue(
          userId, 300, 0, undefined,
          { ratingDelta: 100 },
        );

        expect(result).not.toBeNull();
      });

      it('should skip if candidate filter rejects joiner', async () => {
        const candidateEntry = JSON.stringify({
          userId: opponentId,
          rating: 1450,
          timeInitialSec: 300,
          timeIncrementSec: 0,
          ratingRange: { min: 1400, max: 1480 },
        });

        redis.zrangebyscore.mockResolvedValue([candidateEntry]);

        const result = await service.joinQueue(userId, 300, 0);

        expect(result).toBeNull();
      });

      it('should match when both filters accept each other', async () => {
        const candidateEntry = JSON.stringify({
          userId: opponentId,
          rating: 1450,
          timeInitialSec: 300,
          timeIncrementSec: 0,
          ratingRange: { min: 1400, max: 1600 },
        });

        redis.zrangebyscore.mockResolvedValue([candidateEntry]);
        prisma.game.create.mockResolvedValue({ id: 'game-1' });
        prisma.user.findUnique.mockResolvedValue({
          id: opponentId,
          username: 'opponent',
        });

        const result = await service.joinQueue(
          userId, 300, 0, undefined,
          { minRating: 1400, maxRating: 1600 },
        );

        expect(result).not.toBeNull();
      });

      it('should store ratingRange in queue entry', async () => {
        await service.joinQueue(
          userId, 300, 0, undefined,
          { ratingDelta: 100 },
        );

        const storedEntry = JSON.parse(redis.zadd.mock.calls[0][2]);
        expect(storedEntry.ratingRange).toEqual({ min: 1400, max: 1600 });
      });

      it('should not store ratingRange when no filter', async () => {
        await service.joinQueue(userId, 300, 0);

        const storedEntry = JSON.parse(redis.zadd.mock.calls[0][2]);
        expect(storedEntry.ratingRange).toBeUndefined();
      });

      it('ratingDelta takes precedence over minRating/maxRating', async () => {
        await service.joinQueue(
          userId, 300, 0, undefined,
          { minRating: 1000, maxRating: 2000, ratingDelta: 50 },
        );

        const storedEntry = JSON.parse(redis.zadd.mock.calls[0][2]);
        expect(storedEntry.ratingRange).toEqual({ min: 1450, max: 1550 });
      });
    });
  });

  describe('leaveQueue', () => {
    it('should remove user from queue', async () => {
      const entry = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 300,
        timeIncrementSec: 0,
      });

      redis.zrange.mockResolvedValue([entry]);

      const result = await service.leaveQueue(userId, 'blitz');

      expect(result).toBe(true);
      expect(redis.zrem).toHaveBeenCalledWith('matchmaking:blitz', entry);
    });

    it('should return false when user not in queue', async () => {
      redis.zrange.mockResolvedValue([]);

      const result = await service.leaveQueue(userId, 'blitz');

      expect(result).toBe(false);
    });

    it('should not remove other users from queue', async () => {
      const otherEntry = JSON.stringify({
        userId: opponentId,
        rating: 1500,
        timeInitialSec: 300,
        timeIncrementSec: 0,
      });

      redis.zrange.mockResolvedValue([otherEntry]);

      const result = await service.leaveQueue(userId, 'blitz');

      expect(result).toBe(false);
      expect(redis.zrem).not.toHaveBeenCalled();
    });
  });
});
