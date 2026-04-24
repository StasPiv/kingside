import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus,
  SetMetadata,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../redis/redis.service';
import { AuthenticatedRequest } from './authenticated-request';

/**
 * Per-user rate-limit для эндпоинтов, защищённых `JwtAuthGuard` (KS-1833,
 * ADR-026 §2.2).
 *
 * Отличие от `RedisRateLimitGuard`:
 *  - ключ строится по `req.user.id`, а не по IP. Это принципиально для
 *    user-courses: злоумышленник не может обойти лимит сменой IP или
 *    шарингом IP с другим пользователем.
 *  - при превышении ответ содержит заголовок `Retry-After` (в секундах),
 *    вычисленный как остаток TTL ключа в Redis — клиент может показать
 *    «попробуйте через N сек», а не слепо ретраить.
 *
 * Fail-open при недоступности Redis: если `INCR` упал, пропускаем запрос.
 * Это сознательный выбор — не валить прод при кратком сбое Redis ценой
 * потенциального прохождения 5–10 лишних запросов. Тот же контракт, что
 * и у `RedisRateLimitGuard`.
 *
 * Порядок guard'ов в `@UseGuards(...)` важен: `JwtAuthGuard` ДОЛЖЕН стоять
 * ПЕРЕД `UserRateLimitGuard`, иначе `req.user` будет не заполнен и мы
 * кинем 500 (защитная ошибка, см. ниже).
 */

export const USER_RATE_LIMIT_KEY = 'USER_RATE_LIMIT';

export interface UserRateLimitConfig {
  /** Максимум запросов в окне от одного userId. */
  maxRequests: number;
  /** Длина окна в секундах. */
  windowSec: number;
}

/**
 * Декоратор для задания per-user rate-limit на route или controller.
 * Работает только вместе с `UserRateLimitGuard` в `@UseGuards`.
 *
 * @example
 *   @UseGuards(JwtAuthGuard, UserRateLimitGuard)
 *   @UserRateLimit(5, 600)   // 5 запросов / 10 минут на userId
 *   @Post()
 *   create(@Request() req) { ... }
 */
export const UserRateLimit = (maxRequests: number, windowSec: number) =>
  SetMetadata(USER_RATE_LIMIT_KEY, { maxRequests, windowSec });

const DEFAULT_MAX = 60;
const DEFAULT_WINDOW_SEC = 60;

@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name);

  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<UserRateLimitConfig | undefined>(
      USER_RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    const maxRequests = config?.maxRequests ?? DEFAULT_MAX;
    const windowSec = config?.windowSec ?? DEFAULT_WINDOW_SEC;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.id;

    if (!userId) {
      // Защита от misconfiguration: без JwtAuthGuard перед нами — не работаем.
      // Лучше честно 500, чем тихо пропускать все запросы без лимита.
      this.logger.error(
        `UserRateLimitGuard invoked without authenticated user — check @UseGuards order`,
      );
      throw new HttpException(
        'User rate limit guard requires authenticated request',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // Ключ включает route, чтобы лимиты разных эндпоинтов не делили один
    // счётчик. `request.route?.path` — шаблон ('/user-courses/:id/lessons'),
    // а не конкретный URL, — разные пользователи с одним :id не пересекаются
    // в ключе за счёт userId.
    const route = `${request.method}:${request.route?.path ?? request.path}`;
    const key = `ratelimit:user:${userId}:${route}`;

    try {
      const current = await this.redis.incr(key);
      if (current === 1) {
        await this.redis.expire(key, windowSec);
      }

      if (current > maxRequests) {
        // Retry-After — сколько секунд осталось до сброса окна.
        // `ttl` возвращает -1 если TTL не установлен (теоретически не наш
        // случай — мы expire ставим), -2 если ключ не существует.
        let retryAfter = windowSec;
        try {
          const ttl = await this.redis.ttl(key);
          if (ttl > 0) retryAfter = ttl;
        } catch {
          /* Redis глюкнул на ttl — оставим windowSec как консервативный fallback */
        }

        const response = context.switchToHttp().getResponse();
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
    } catch (e) {
      if (e instanceof HttpException) throw e;
      // Redis error — fail open (логируем, пропускаем).
      this.logger.warn(`UserRateLimitGuard: Redis error, failing open: ${(e as Error).message}`);
    }

    return true;
  }
}
