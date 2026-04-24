import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { UserRateLimitGuard } from './user-rate-limit.guard';

describe('UserRateLimitGuard (KS-1833)', () => {
  let guard: UserRateLimitGuard;
  let redis: { incr: jest.Mock; expire: jest.Mock; ttl: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };
  let responseHeaders: Record<string, string>;

  const mockContext = (
    userId: string | null = 'user-1',
    path = '/lessons/user-courses',
    method = 'POST',
  ) => {
    responseHeaders = {};
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          user: userId ? { id: userId, username: 'u' } : undefined,
          method,
          route: { path },
          path,
        }),
        getResponse: () => ({
          setHeader: (name: string, value: string) => {
            responseHeaders[name] = value;
          },
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    redis = {
      incr: jest.fn(),
      expire: jest.fn(),
      ttl: jest.fn(),
    };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    guard = new UserRateLimitGuard(redis as any, reflector as any);
  });

  describe('базовое поведение', () => {
    it('пропускает запрос под лимитом', async () => {
      redis.incr.mockResolvedValue(1);
      await expect(guard.canActivate(mockContext())).resolves.toBe(true);
      expect(redis.expire).toHaveBeenCalled();
    });

    it('expire выставляется ТОЛЬКО при первом запросе (incr === 1)', async () => {
      redis.incr.mockResolvedValue(1);
      await guard.canActivate(mockContext());
      expect(redis.expire).toHaveBeenCalledTimes(1);
      expect(redis.expire).toHaveBeenCalledWith(expect.any(String), 60); // DEFAULT_WINDOW_SEC
    });

    it('expire НЕ выставляется при последующих запросах', async () => {
      redis.incr.mockResolvedValue(5);
      await guard.canActivate(mockContext());
      expect(redis.expire).not.toHaveBeenCalled();
    });

    it('пропускает запрос ровно на границе лимита (incr === max)', async () => {
      reflector.getAllAndOverride.mockReturnValue({ maxRequests: 5, windowSec: 600 });
      redis.incr.mockResolvedValue(5);
      await expect(guard.canActivate(mockContext())).resolves.toBe(true);
    });
  });

  describe('превышение лимита', () => {
    it('на 6-м запросе при лимите 5 — кидает 429', async () => {
      reflector.getAllAndOverride.mockReturnValue({ maxRequests: 5, windowSec: 600 });
      redis.incr.mockResolvedValue(6);
      redis.ttl.mockResolvedValue(580);

      await expect(guard.canActivate(mockContext())).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
    });

    it('ответ 429 включает Retry-After с остатком TTL окна', async () => {
      reflector.getAllAndOverride.mockReturnValue({ maxRequests: 5, windowSec: 600 });
      redis.incr.mockResolvedValue(6);
      redis.ttl.mockResolvedValue(123);

      await expect(guard.canActivate(mockContext())).rejects.toBeInstanceOf(HttpException);
      expect(responseHeaders['Retry-After']).toBe('123');
    });

    it('если Redis.ttl вернул -1/-2 — Retry-After падает на windowSec', async () => {
      reflector.getAllAndOverride.mockReturnValue({ maxRequests: 5, windowSec: 600 });
      redis.incr.mockResolvedValue(6);
      redis.ttl.mockResolvedValue(-1);

      await expect(guard.canActivate(mockContext())).rejects.toBeInstanceOf(HttpException);
      expect(responseHeaders['Retry-After']).toBe('600');
    });

    it('body ответа 429 содержит поле retryAfter', async () => {
      reflector.getAllAndOverride.mockReturnValue({ maxRequests: 5, windowSec: 600 });
      redis.incr.mockResolvedValue(6);
      redis.ttl.mockResolvedValue(42);

      try {
        await guard.canActivate(mockContext());
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        const resp = (e as HttpException).getResponse() as { retryAfter: number };
        expect(resp.retryAfter).toBe(42);
      }
    });
  });

  describe('ключ rate-limit', () => {
    it('для разных userId — разные ключи', async () => {
      redis.incr.mockResolvedValue(1);
      await guard.canActivate(mockContext('alice'));
      await guard.canActivate(mockContext('bob'));

      const keys = redis.incr.mock.calls.map((c) => c[0]);
      expect(keys[0]).not.toBe(keys[1]);
      expect(keys[0]).toContain('alice');
      expect(keys[1]).toContain('bob');
    });

    it('для разных route одного userId — разные ключи', async () => {
      redis.incr.mockResolvedValue(1);
      await guard.canActivate(mockContext('alice', '/lessons/user-courses', 'POST'));
      await guard.canActivate(mockContext('alice', '/lessons/user-courses/:id/lessons', 'POST'));

      const keys = redis.incr.mock.calls.map((c) => c[0]);
      expect(keys[0]).not.toBe(keys[1]);
    });

    it('ключ содержит userId, а не IP (per-user isolation)', async () => {
      redis.incr.mockResolvedValue(1);
      await guard.canActivate(mockContext('alice'));
      const key = redis.incr.mock.calls[0][0];
      expect(key).toMatch(/^ratelimit:user:alice:POST:/);
    });
  });

  describe('misconfiguration', () => {
    it('без req.user — 500 (два guard\'а переставлены местами)', async () => {
      redis.incr.mockResolvedValue(1);
      await expect(guard.canActivate(mockContext(null))).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });
    });
  });

  describe('Redis failure — fail-open', () => {
    it('incr упал → пропускаем запрос (fail-open)', async () => {
      redis.incr.mockRejectedValue(new Error('Redis down'));
      await expect(guard.canActivate(mockContext())).resolves.toBe(true);
    });
  });

  describe('сценарий из DoD: 5 req / 10 мин', () => {
    it('5 подряд проходят, 6-й отбивается', async () => {
      reflector.getAllAndOverride.mockReturnValue({ maxRequests: 5, windowSec: 600 });
      redis.ttl.mockResolvedValue(600);

      for (let i = 1; i <= 5; i++) {
        redis.incr.mockResolvedValueOnce(i);
        await expect(guard.canActivate(mockContext())).resolves.toBe(true);
      }

      redis.incr.mockResolvedValueOnce(6);
      await expect(guard.canActivate(mockContext())).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
    });
  });
});
