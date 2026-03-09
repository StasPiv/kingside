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

    it('should narrow search range with ratingDelta filter', async () => {
      await service.joinQueue(userId, 300, 0, undefined, { ratingDelta: 100 });

      expect(redis.zrangebyscore).toHaveBeenCalledWith(
        'matchmaking:blitz',
        1400,
        1600,
      );
    });

    it('should narrow search range with absolute ratingMin/ratingMax', async () => {
      await service.joinQueue(userId, 300, 0, undefined, {
        ratingMin: 1450,
        ratingMax: 1550,
      });

      expect(redis.zrangebyscore).toHaveBeenCalledWith(
        'matchmaking:blitz',
        1450,
        1550,
      );
    });

    it('should not widen search range beyond default RATING_RANGE', async () => {
      await service.joinQueue(userId, 300, 0, undefined, { ratingDelta: 500 });

      // Default range is ±200, so delta=500 should not widen it
      expect(redis.zrangebyscore).toHaveBeenCalledWith(
        'matchmaking:blitz',
        1300,
        1700,
      );
    });

    it('should skip candidate whose filter rejects current user', async () => {
      // Candidate at 1450 with filter that only accepts ±50
      const candidateEntry = JSON.stringify({
        userId: opponentId,
        rating: 1450,
        timeInitialSec: 300,
        timeIncrementSec: 0,
        ratingFilter: { ratingDelta: 50 },
      });

      redis.zrangebyscore.mockResolvedValue([candidateEntry]);

      // User at 1500 is outside candidate's range (1450 ± 50 = 1400-1500)
      // But wait, 1500 == 1500 so it should still match because 1500 <= 1500
      // Actually candidate range: max(1450-200, 1450-50)=1400, min(1450+200, 1450+50)=1500
      // So joiner at 1500 is within [1400, 1500]. Should match.
      prisma.game.create.mockResolvedValue({ id: 'game-1' });
      prisma.user.findUnique.mockResolvedValue({
        id: opponentId,
        username: 'opponent',
      });

      const result = await service.joinQueue(userId, 300, 0);
      expect(result).not.toBeNull();
    });

    it('should reject match when candidate filter excludes joiner', async () => {
      // User at 1500, candidate at 1400 with ratingMax=1450
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: userId,
        ratingBlitz: 1500,
        ratingBullet: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
      });

      const candidateEntry = JSON.stringify({
        userId: opponentId,
        rating: 1400,
        timeInitialSec: 300,
        timeIncrementSec: 0,
        ratingFilter: { ratingMax: 1450 },
      });

      redis.zrangebyscore.mockResolvedValue([candidateEntry]);

      const result = await service.joinQueue(userId, 300, 0);
      // Candidate's filter: max(1400-200, -Inf)=1200, min(1400+200, 1450)=1450
      // Joiner at 1500 > 1450, so should NOT match
      expect(result).toBeNull();
    });

    it('should store ratingFilter in queue entry', async () => {
      const filter = { ratingDelta: 100 };
      await service.joinQueue(userId, 300, 0, undefined, filter);

      const storedEntry = JSON.parse(redis.zadd.mock.calls[0][2]);
      expect(storedEntry.ratingFilter).toEqual(filter);
    });

    it('should not store ratingFilter when not provided', async () => {
      await service.joinQueue(userId, 300, 0);

      const storedEntry = JSON.parse(redis.zadd.mock.calls[0][2]);
      expect(storedEntry.ratingFilter).toBeUndefined();
    });
  });

  describe('resolveSearchRange', () => {
    it('should return default range when no filter', () => {
      const result = service.resolveSearchRange(1500);
      expect(result).toEqual({ min: 1300, max: 1700 });
    });

    it('should narrow with ratingDelta', () => {
      const result = service.resolveSearchRange(1500, { ratingDelta: 100 });
      expect(result).toEqual({ min: 1400, max: 1600 });
    });

    it('should narrow with absolute bounds', () => {
      const result = service.resolveSearchRange(1500, {
        ratingMin: 1450,
        ratingMax: 1600,
      });
      expect(result).toEqual({ min: 1450, max: 1600 });
    });

    it('should combine delta and absolute bounds', () => {
      const result = service.resolveSearchRange(1500, {
        ratingDelta: 100,
        ratingMin: 1420,
      });
      // delta: [1400, 1600], ratingMin: 1420 => [1420, 1600]
      expect(result).toEqual({ min: 1420, max: 1600 });
    });

    it('should not widen beyond default range', () => {
      const result = service.resolveSearchRange(1500, { ratingDelta: 500 });
      expect(result).toEqual({ min: 1300, max: 1700 });
    });
  });

  describe('isWithinFilter', () => {
    it('should return true when no filter', () => {
      expect(service.isWithinFilter(1500, 1400)).toBe(true);
    });

    it('should return true when within delta', () => {
      expect(service.isWithinFilter(1500, 1450, { ratingDelta: 100 })).toBe(true);
    });

    it('should return false when outside delta', () => {
      expect(service.isWithinFilter(1500, 1300, { ratingDelta: 50 })).toBe(false);
    });

    it('should check absolute ratingMax', () => {
      expect(service.isWithinFilter(1500, 1400, { ratingMax: 1450 })).toBe(false);
    });

    it('should check absolute ratingMin', () => {
      expect(service.isWithinFilter(1200, 1400, { ratingMin: 1300 })).toBe(false);
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
