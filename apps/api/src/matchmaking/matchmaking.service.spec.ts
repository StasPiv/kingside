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
  let redis: any;
  let gameService: any;
  let prisma: any;

  const userId = '11111111-1111-4111-a111-111111111111';
  const opponentId = '22222222-2222-4222-a222-222222222222';

  beforeEach(() => {
    redis = {
      zrangebyscore: jest.fn().mockResolvedValue([]),
      zadd: jest.fn().mockResolvedValue(1),
      zrem: jest.fn().mockResolvedValue(1),
      zrange: jest.fn().mockResolvedValue([]),
    };

    gameService = {
      initGame: jest.fn().mockResolvedValue({}),
    };

    prisma = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          ratingBlitz: 1500,
          ratingBullet: 1500,
          ratingRapid: 1500,
          ratingClassical: 1500,
        }),
        findUnique: jest.fn().mockResolvedValue({
          id: opponentId,
          username: 'opponent',
        }),
      },
      game: {
        create: jest.fn().mockResolvedValue({
          id: 'game-1',
          whiteId: userId,
          blackId: opponentId,
        }),
      },
    };

    service = new MatchmakingService(redis, gameService, prisma);
  });

  describe('joinQueue', () => {
    it('should add to queue when no opponents found', async () => {
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
        rating: 1480,
        timeInitialSec: 300,
        timeIncrementSec: 0,
      });
      redis.zrangebyscore.mockResolvedValue([candidateEntry]);

      const result = await service.joinQueue(userId, 300, 0);

      expect(result).not.toBeNull();
      expect(result!.gameId).toBe('game-1');
      expect(redis.zrem).toHaveBeenCalledWith('matchmaking:blitz', candidateEntry);
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
    });

    it('should skip candidates with different time control', async () => {
      const candidateEntry = JSON.stringify({
        userId: opponentId,
        rating: 1500,
        timeInitialSec: 600, // different from requested 300
        timeIncrementSec: 0,
      });
      redis.zrangebyscore.mockResolvedValue([candidateEntry]);

      const result = await service.joinQueue(userId, 300, 0);

      expect(result).toBeNull();
    });

    it('should use correct rating field for bullet', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ratingBullet: 1300,
        ratingBlitz: 1500,
      });

      await service.joinQueue(userId, 60, 0);

      expect(redis.zadd).toHaveBeenCalledWith(
        'matchmaking:bullet',
        1300,
        expect.any(String),
      );
    });

    it('should use correct rating field for rapid', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ratingRapid: 1600,
      });

      await service.joinQueue(userId, 600, 0);

      expect(redis.zadd).toHaveBeenCalledWith(
        'matchmaking:rapid',
        1600,
        expect.any(String),
      );
    });
  });

  describe('leaveQueue', () => {
    it('should remove user from queue', async () => {
      const entry = JSON.stringify({ userId, rating: 1500 });
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
  });
});
