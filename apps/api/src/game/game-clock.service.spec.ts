jest.mock('../redis/redis.service', () => ({
  RedisService: jest.fn(),
}));

import { GameClockService, ClockState } from './game-clock.service';

describe('GameClockService', () => {
  let service: GameClockService;
  let redis: any;
  const gameId = 'game-1';

  beforeEach(() => {
    redis = {
      hset: jest.fn().mockResolvedValue(1),
      hgetall: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
    };

    service = new GameClockService(redis);
  });

  describe('initClocks', () => {
    it('should initialize clocks with given time', async () => {
      const result = await service.initClocks(gameId, 300000);

      expect(result.whiteMs).toBe(300000);
      expect(result.blackMs).toBe(300000);
      expect(result.running).toBe(false);
      expect(redis.hset).toHaveBeenCalledWith(
        `game:${gameId}:clocks`,
        expect.objectContaining({
          white_ms: '300000',
          black_ms: '300000',
          running: '0',
        }),
      );
    });
  });

  describe('startClock', () => {
    it('should set running flag to 1', async () => {
      await service.startClock(gameId);

      expect(redis.hset).toHaveBeenCalledWith(
        `game:${gameId}:clocks`,
        expect.objectContaining({ running: '1' }),
      );
    });
  });

  describe('switchClock', () => {
    it('should deduct elapsed time from moving player and add increment', async () => {
      const now = Date.now();
      redis.hgetall.mockResolvedValue({
        white_ms: '300000',
        black_ms: '300000',
        last_tick: String(now - 5000), // 5 seconds ago
        running: '1',
      });

      const result = await service.switchClock(gameId, 'white', 2000);

      // White had 300000ms, 5000ms elapsed, +2000ms increment = 297000ms
      expect(result.whiteMs).toBeLessThanOrEqual(297000 + 100); // small tolerance for test execution time
      expect(result.blackMs).toBe(300000);
      expect(result.running).toBe(true);
    });

    it('should not go below 0ms', async () => {
      const now = Date.now();
      redis.hgetall.mockResolvedValue({
        white_ms: '1000',
        black_ms: '300000',
        last_tick: String(now - 5000),
        running: '1',
      });

      const result = await service.switchClock(gameId, 'white', 0);

      expect(result.whiteMs).toBe(0);
    });

    it('should switch black clock correctly', async () => {
      const now = Date.now();
      redis.hgetall.mockResolvedValue({
        white_ms: '300000',
        black_ms: '250000',
        last_tick: String(now - 3000),
        running: '1',
      });

      const result = await service.switchClock(gameId, 'black', 5000);

      // Black had 250000ms, 3000ms elapsed, +5000ms increment = 252000ms
      expect(result.blackMs).toBeLessThanOrEqual(252000 + 100);
      expect(result.whiteMs).toBe(300000);
    });
  });

  describe('getClocks', () => {
    it('should return clock state from Redis', async () => {
      redis.hgetall.mockResolvedValue({
        white_ms: '290000',
        black_ms: '285000',
        last_tick: '1700000000000',
        running: '1',
      });

      const result = await service.getClocks(gameId);

      expect(result.whiteMs).toBe(290000);
      expect(result.blackMs).toBe(285000);
      expect(result.running).toBe(true);
    });

    it('should return zeroed state when no data', async () => {
      redis.hgetall.mockResolvedValue({});

      const result = await service.getClocks(gameId);

      expect(result.whiteMs).toBe(0);
      expect(result.blackMs).toBe(0);
      expect(result.running).toBe(false);
    });
  });

  describe('checkTimeout', () => {
    it('should detect timeout when time expired', async () => {
      const now = Date.now();
      redis.hgetall.mockResolvedValue({
        white_ms: '1000',
        black_ms: '300000',
        last_tick: String(now - 5000), // 5 seconds ago, white only had 1s
        running: '1',
      });

      const result = await service.checkTimeout(gameId, 'white');

      expect(result.timedOut).toBe(true);
      expect(result.clocks.whiteMs).toBe(0);
    });

    it('should not timeout when time remaining', async () => {
      const now = Date.now();
      redis.hgetall.mockResolvedValue({
        white_ms: '300000',
        black_ms: '300000',
        last_tick: String(now - 1000),
        running: '1',
      });

      const result = await service.checkTimeout(gameId, 'white');

      expect(result.timedOut).toBe(false);
      expect(result.clocks.whiteMs).toBeGreaterThan(0);
    });

    it('should return no timeout when no clock data', async () => {
      redis.hgetall.mockResolvedValue({});

      const result = await service.checkTimeout(gameId, 'white');

      expect(result.timedOut).toBe(false);
    });
  });

  describe('stopClock', () => {
    it('should set running to false', async () => {
      redis.hgetall.mockResolvedValue({
        white_ms: '250000',
        black_ms: '280000',
        last_tick: '1700000000000',
        running: '1',
      });

      const result = await service.stopClock(gameId);

      expect(result.running).toBe(false);
      expect(redis.hset).toHaveBeenCalledWith(
        `game:${gameId}:clocks`,
        { running: '0' },
      );
    });
  });

  describe('deleteClock', () => {
    it('should remove clock data from Redis', async () => {
      await service.deleteClock(gameId);

      expect(redis.del).toHaveBeenCalledWith(`game:${gameId}:clocks`);
    });
  });
});
