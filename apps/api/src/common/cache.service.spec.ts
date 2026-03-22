import { CacheService } from './cache.service';

describe('CacheService', () => {
  let service: CacheService;
  let redis: { get: jest.Mock; set: jest.Mock; keys: jest.Mock; del: jest.Mock };

  beforeEach(() => {
    redis = {
      get: jest.fn(),
      set: jest.fn(),
      keys: jest.fn(),
      del: jest.fn(),
    };
    service = new CacheService(redis as any);
  });

  describe('getOrSet', () => {
    it('should return cached value if exists', async () => {
      redis.get.mockResolvedValue(JSON.stringify({ data: [1, 2, 3] }));
      const compute = jest.fn();

      const result = await service.getOrSet('key', 60, compute);

      expect(result).toEqual({ data: [1, 2, 3] });
      expect(compute).not.toHaveBeenCalled();
    });

    it('should compute and cache if not cached', async () => {
      redis.get.mockResolvedValue(null);
      redis.set.mockResolvedValue('OK');

      const result = await service.getOrSet('key', 60, async () => ({ value: 42 }));

      expect(result).toEqual({ value: 42 });
      expect(redis.set).toHaveBeenCalledWith('key', '{"value":42}', 'EX', 60);
    });

    it('should compute fresh on Redis read error', async () => {
      redis.get.mockRejectedValue(new Error('Redis down'));
      redis.set.mockResolvedValue('OK');

      const result = await service.getOrSet('key', 60, async () => 'fresh');

      expect(result).toBe('fresh');
    });

    it('should return computed value even if Redis write fails', async () => {
      redis.get.mockResolvedValue(null);
      redis.set.mockRejectedValue(new Error('Redis down'));

      const result = await service.getOrSet('key', 60, async () => 'value');

      expect(result).toBe('value');
    });
  });

  describe('invalidate', () => {
    it('should delete keys matching pattern', async () => {
      redis.keys.mockResolvedValue(['cache:a', 'cache:b']);
      redis.del.mockResolvedValue(2);

      await service.invalidate('cache:*');

      expect(redis.del).toHaveBeenCalledWith('cache:a', 'cache:b');
    });

    it('should skip del if no keys match', async () => {
      redis.keys.mockResolvedValue([]);

      await service.invalidate('cache:*');

      expect(redis.del).not.toHaveBeenCalled();
    });
  });
});
