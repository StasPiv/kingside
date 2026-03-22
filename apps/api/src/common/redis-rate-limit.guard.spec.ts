import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisRateLimitGuard } from './redis-rate-limit.guard';

describe('RedisRateLimitGuard', () => {
  let guard: RedisRateLimitGuard;
  let redis: { incr: jest.Mock; expire: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };

  const mockContext = (ip = '127.0.0.1', path = '/api/players/top', method = 'GET') => ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { 'x-forwarded-for': ip },
        socket: { remoteAddress: ip },
        method,
        route: { path },
      }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  }) as unknown as ExecutionContext;

  beforeEach(() => {
    redis = { incr: jest.fn(), expire: jest.fn() };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    guard = new RedisRateLimitGuard(redis as any, reflector as any);
  });

  it('should allow request under limit', async () => {
    redis.incr.mockResolvedValue(1);

    const result = await guard.canActivate(mockContext());

    expect(result).toBe(true);
    expect(redis.expire).toHaveBeenCalled();
  });

  it('should allow request at limit boundary', async () => {
    redis.incr.mockResolvedValue(60); // default max

    const result = await guard.canActivate(mockContext());

    expect(result).toBe(true);
  });

  it('should reject request over limit', async () => {
    redis.incr.mockResolvedValue(61);

    await expect(guard.canActivate(mockContext())).rejects.toThrow(
      new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS),
    );
  });

  it('should use custom limit from @RateLimit decorator', async () => {
    reflector.getAllAndOverride.mockReturnValue({ maxRequests: 5, windowSec: 30 });
    redis.incr.mockResolvedValue(6);

    await expect(guard.canActivate(mockContext())).rejects.toThrow(
      new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS),
    );
  });

  it('should set expire only on first request (incr returns 1)', async () => {
    redis.incr.mockResolvedValue(1);

    await guard.canActivate(mockContext());

    expect(redis.expire).toHaveBeenCalledWith(expect.any(String), 60);
  });

  it('should NOT set expire on subsequent requests', async () => {
    redis.incr.mockResolvedValue(5);

    await guard.canActivate(mockContext());

    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('should fail open on Redis error', async () => {
    redis.incr.mockRejectedValue(new Error('Redis unavailable'));

    const result = await guard.canActivate(mockContext());

    expect(result).toBe(true);
  });

  it('should use different keys for different IPs', async () => {
    redis.incr.mockResolvedValue(1);

    await guard.canActivate(mockContext('1.1.1.1'));
    await guard.canActivate(mockContext('2.2.2.2'));

    const keys = redis.incr.mock.calls.map((c: string[]) => c[0]);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
