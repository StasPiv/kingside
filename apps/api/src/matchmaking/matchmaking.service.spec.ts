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

    describe('rating range filter', () => {
      it('should use absolute rating range for Redis query', async () => {
        await service.joinQueue(userId, 300, 0, undefined, {
          mode: 'absolute',
          min: 1400,
          max: 2800,
        });

        expect(redis.zrangebyscore).toHaveBeenCalledWith(
          'matchmaking:blitz',
          1400,
          2800,
        );
      });

      it('should use relative rating range for Redis query', async () => {
        await service.joinQueue(userId, 300, 0, undefined, {
          mode: 'relative',
          below: 100,
          above: 200,
        });

        // rating=1500, so range is 1400..1700
        expect(redis.zrangebyscore).toHaveBeenCalledWith(
          'matchmaking:blitz',
          1400,
          1700,
        );
      });

      it('should use default ±200 range when no ratingRange provided', async () => {
        await service.joinQueue(userId, 300, 0);

        expect(redis.zrangebyscore).toHaveBeenCalledWith(
          'matchmaking:blitz',
          1300,
          1700,
        );
      });

      it('should store ratingRange in queue entry', async () => {
        const ratingRange = { mode: 'relative' as const, below: 100, above: 200 };
        await service.joinQueue(userId, 300, 0, undefined, ratingRange);

        const storedEntry = JSON.parse(redis.zadd.mock.calls[0][2]);
        expect(storedEntry.ratingRange).toEqual(ratingRange);
      });

      it('should skip candidate whose range excludes our rating', async () => {
        // Candidate has rating 1450 with absolute range 1400-1460
        // Our rating is 1500 — outside their range
        const candidateEntry = JSON.stringify({
          userId: opponentId,
          rating: 1450,
          timeInitialSec: 300,
          timeIncrementSec: 0,
          ratingRange: { mode: 'absolute', min: 1400, max: 1460 },
        });

        redis.zrangebyscore.mockResolvedValue([candidateEntry]);

        const result = await service.joinQueue(userId, 300, 0);

        expect(result).toBeNull();
        expect(redis.zadd).toHaveBeenCalled();
      });

      it('should match when both players rating ranges are compatible', async () => {
        // Candidate has rating 1450 with relative range -100/+200
        // So candidate accepts 1350..1650, our rating 1500 fits
        const candidateEntry = JSON.stringify({
          userId: opponentId,
          rating: 1450,
          timeInitialSec: 300,
          timeIncrementSec: 0,
          ratingRange: { mode: 'relative', below: 100, above: 200 },
        });

        redis.zrangebyscore.mockResolvedValue([candidateEntry]);
        prisma.game.create.mockResolvedValue({ id: 'game-1' });
        prisma.user.findUnique.mockResolvedValue({
          id: opponentId,
          username: 'opponent',
        });

        // Our range: absolute 1400..2800 — candidate's 1450 fits
        const result = await service.joinQueue(userId, 300, 0, undefined, {
          mode: 'absolute',
          min: 1400,
          max: 2800,
        });

        expect(result).not.toBeNull();
        expect(result!.gameId).toBe('game-1');
      });

      it('should skip candidate with relative range that excludes our rating', async () => {
        // Candidate rating 1450, relative range -50/+50 → accepts 1400..1500
        // Our rating 1500 is at boundary — should match (inclusive)
        const candidateEntry = JSON.stringify({
          userId: opponentId,
          rating: 1700,
          timeInitialSec: 300,
          timeIncrementSec: 0,
          ratingRange: { mode: 'relative', below: 50, above: 50 },
        });

        redis.zrangebyscore.mockResolvedValue([candidateEntry]);

        // Candidate accepts 1650..1750, our rating 1500 is outside
        const result = await service.joinQueue(userId, 300, 0, undefined, {
          mode: 'absolute',
          min: 1000,
          max: 2000,
        });

        expect(result).toBeNull();
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
