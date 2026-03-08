jest.mock('../redis/redis.service', () => ({
  RedisService: jest.fn(),
}));

import { GameClockService, ClockState } from './game-clock.service';

describe('GameClockService', () => {
  let service: GameClockService;
  let redis: any;

  const gameId = 'game-001';

  beforeEach(() => {
    redis = {
      hset: jest.fn().mockResolvedValue(undefined),
      hgetall: jest.fn(),
      del: jest.fn().mockResolvedValue(undefined),
    };

    service = new GameClockService(redis);
  });

  describe('initClocks', () => {
    it('should store initial clock state in redis', async () => {
      const result = await service.initClocks(gameId, 300000);

      expect(redis.hset).toHaveBeenCalledWith(`game:${gameId}:clocks`, {
        white_ms: '300000',
        black_ms: '300000',
        last_tick: expect.any(String),
        running: '0',
      });
      expect(result.whiteMs).toBe(300000);
      expect(result.blackMs).toBe(300000);
      expect(result.running).toBe(false);
    });
  });

  describe('startClock', () => {
    it('should set running flag and update last_tick', async () => {
      await service.startClock(gameId);

      expect(redis.hset).toHaveBeenCalledWith(`game:${gameId}:clocks`, {
        last_tick: expect.any(String),
        running: '1',
      });
    });
  });

  describe('switchClock', () => {
    it('should subtract elapsed time from mover and add increment', async () => {
      const now = Date.now();
      redis.hgetall.mockResolvedValue({
        white_ms: '300000',
        black_ms: '300000',
        last_tick: String(now - 5000),
        running: '1',
      });

      const result = await service.switchClock(gameId, 'white', 2000);

      // white moved, elapsed ~5000ms, increment 2000ms => ~297000ms remaining
      expect(result.whiteMs).toBeLessThanOrEqual(297100);
      expect(result.whiteMs).toBeGreaterThanOrEqual(296900);
      expect(result.blackMs).toBe(300000);
      expect(result.running).toBe(true);
    });

    it('should not go below 0 ms', async () => {
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

    it('should handle black moving', async () => {
      const now = Date.now();
      redis.hgetall.mockResolvedValue({
        white_ms: '300000',
        black_ms: '300000',
        last_tick: String(now - 3000),
        running: '1',
      });

      const result = await service.switchClock(gameId, 'black', 1000);

      expect(result.blackMs).toBeLessThanOrEqual(298100);
      expect(result.blackMs).toBeGreaterThanOrEqual(297900);
      expect(result.whiteMs).toBe(300000);
    });
  });

  describe('getClocks', () => {
    it('should return clock state from redis', async () => {
      redis.hgetall.mockResolvedValue({
        white_ms: '250000',
        black_ms: '280000',
        last_tick: '1700000000000',
        running: '1',
      });

      const result = await service.getClocks(gameId);

      expect(result).toEqual({
        whiteMs: 250000,
        blackMs: 280000,
        lastTick: 1700000000000,
        running: true,
      });
    });

    it('should return zeros when no clock data exists', async () => {
      redis.hgetall.mockResolvedValue({});

      const result = await service.getClocks(gameId);

      expect(result).toEqual({
        whiteMs: 0,
        blackMs: 0,
        lastTick: 0,
        running: false,
      });
    });
  });

  describe('checkTimeout', () => {
    it('should detect timeout when time is exhausted', async () => {
      const now = Date.now();
      redis.hgetall.mockResolvedValue({
        white_ms: '1000',
        black_ms: '300000',
        last_tick: String(now - 5000),
        running: '1',
      });

      const result = await service.checkTimeout(gameId, 'white');

      expect(result.timedOut).toBe(true);
      expect(result.clocks.whiteMs).toBe(0);
    });

    it('should not timeout when time remains', async () => {
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

    it('should return defaults when no clock data', async () => {
      redis.hgetall.mockResolvedValue({});

      const result = await service.checkTimeout(gameId, 'white');

      expect(result.timedOut).toBe(false);
      expect(result.clocks).toEqual({
        whiteMs: 0,
        blackMs: 0,
        lastTick: 0,
        running: false,
      });
    });

    it('should only subtract from active color', async () => {
      const now = Date.now();
      redis.hgetall.mockResolvedValue({
        white_ms: '100000',
        black_ms: '200000',
        last_tick: String(now - 2000),
        running: '1',
      });

      const result = await service.checkTimeout(gameId, 'black');

      expect(result.clocks.whiteMs).toBe(100000);
      expect(result.clocks.blackMs).toBeLessThan(200000);
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

      expect(redis.hset).toHaveBeenCalledWith(`game:${gameId}:clocks`, {
        running: '0',
      });
      expect(result.running).toBe(false);
      expect(result.whiteMs).toBe(250000);
    });
  });

  describe('deleteClock', () => {
    it('should delete the clock key from redis', async () => {
      await service.deleteClock(gameId);

      expect(redis.del).toHaveBeenCalledWith(`game:${gameId}:clocks`);
    });
  });
});
