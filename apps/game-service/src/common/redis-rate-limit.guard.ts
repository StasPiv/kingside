import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { RedisService } from '../redis/redis.service';

export const RATE_LIMIT_KEY = 'RATE_LIMIT';

/**
 * Decorator to set rate limit on a controller or route.
 * @param maxRequests — max requests per window
 * @param windowSec — window duration in seconds
 */
export const RateLimit = (maxRequests: number, windowSec: number) =>
  SetMetadata(RATE_LIMIT_KEY, { maxRequests, windowSec });

const DEFAULT_MAX = 60;
const DEFAULT_WINDOW_SEC = 60;

@Injectable()
export class RedisRateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<
      { maxRequests: number; windowSec: number } | undefined
    >(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);

    const maxRequests = config?.maxRequests ?? DEFAULT_MAX;
    const windowSec = config?.windowSec ?? DEFAULT_WINDOW_SEC;

    const request = context.switchToHttp().getRequest<Request>();
    const ip =
      (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      request.socket.remoteAddress ||
      'unknown';

    const route = request.method + ':' + request.route?.path;
    const key = `ratelimit:${ip}:${route}`;

    try {
      const current = await this.redis.incr(key);
      if (current === 1) {
        await this.redis.expire(key, windowSec);
      }

      if (current > maxRequests) {
        throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
      }
    } catch (e) {
      if (e instanceof HttpException) throw e;
      // Redis error — allow request (fail open)
    }

    return true;
  }
}
