/**
 * KS-4471 / ADR-140 T5. Per-user rate-limit для POST
 * /blog/posts/:id/comments с ДВУМЯ окнами:
 *   - 1 запрос / 30 секунд — против burst-спама подряд;
 *   - 30 запросов / час — против устойчивого спама на длинной
 *     дистанции.
 *
 * Реализован отдельным guard'ом, потому что стандартный
 * `UserRateLimitGuard` хранит одно окно на route. Логика —
 * `INCR + EXPIRE` по двум ключам Redis: первое превышение возвращает
 * 429 с заголовком `Retry-After` (TTL соответствующего ключа). Если
 * превышены оба — берётся наибольший `Retry-After`.
 *
 * Fail-open при недоступности Redis — по образцу `UserRateLimitGuard`:
 * лучше пропустить с шумом в логе, чем валить прод. Дополнительно
 * прод закрыт `RedisRateLimitGuard` (per-IP) на других маршрутах, тут
 * мы не единственный барьер.
 */
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

const SHORT_WINDOW_SEC = 30;
const SHORT_WINDOW_MAX = 1;
const LONG_WINDOW_SEC = 60 * 60;
const LONG_WINDOW_MAX = 30;

@Injectable()
export class BlogCommentCreateRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(BlogCommentCreateRateLimitGuard.name);

  constructor(private readonly redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = req.user?.id;
    if (!userId) {
      // Защита от misconfiguration: гард ставится ПОСЛЕ JwtAuthGuard.
      // Без `req.user` лучше явная 500, чем тихий обход лимита.
      this.logger.error(
        'BlogCommentCreateRateLimitGuard without authenticated user — check @UseGuards order',
      );
      throw new HttpException(
        'Rate limit guard requires authenticated request',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const shortKey = `ratelimit:user:${userId}:blog:comment:short`;
    const longKey = `ratelimit:user:${userId}:blog:comment:long`;
    let retryAfter = 0;

    try {
      const shortOk = await this.tryWindow(
        shortKey,
        SHORT_WINDOW_MAX,
        SHORT_WINDOW_SEC,
      );
      if (shortOk.exceeded) {
        retryAfter = Math.max(retryAfter, shortOk.retryAfter);
      }
      const longOk = await this.tryWindow(
        longKey,
        LONG_WINDOW_MAX,
        LONG_WINDOW_SEC,
      );
      if (longOk.exceeded) {
        retryAfter = Math.max(retryAfter, longOk.retryAfter);
      }
    } catch (e) {
      // Redis-сбой → fail-open.
      this.logger.warn(
        `BlogCommentCreateRateLimitGuard: redis error, failing open: ${(e as Error).message}`,
      );
      return true;
    }

    if (retryAfter > 0) {
      const response = ctx.switchToHttp().getResponse<{
        setHeader?: (name: string, value: string) => void;
      }>();
      response.setHeader?.('Retry-After', String(retryAfter));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too Many Requests',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /** Инкрементит счётчик окна и возвращает {exceeded, retryAfter}. */
  private async tryWindow(
    key: string,
    max: number,
    windowSec: number,
  ): Promise<{ exceeded: boolean; retryAfter: number }> {
    const current = await this.redis.incr(key);
    if (current === 1) {
      await this.redis.expire(key, windowSec);
    }
    if (current > max) {
      let ttl = windowSec;
      try {
        const got = await this.redis.ttl(key);
        if (got > 0) ttl = got;
      } catch {
        /* fallback to windowSec */
      }
      return { exceeded: true, retryAfter: ttl };
    }
    return { exceeded: false, retryAfter: 0 };
  }
}
