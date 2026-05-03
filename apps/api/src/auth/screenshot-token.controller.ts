import {
  CanActivate,
  Controller,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  RateLimit,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../metrics/metrics.service';
import { parseExpiresInSeconds } from './internal-auth.controller';
import { SCREENSHOT_AGENT_USERNAME } from '../scripts/seed-screenshot-account';

/**
 * KS-2305 — обёртка над `RedisRateLimitGuard`, которая после
 * срабатывания лимита (HTTP 429) пишет structured-log с
 * `outcome=rate_limited`. Сама логика подсчёта/expire'а делегируется
 * базовому guard'у — здесь только аудит-слой.
 *
 * Wrapping вместо наследования — потому что `RedisRateLimitGuard`
 * уже зарегистрирован глобально через DI (стандартный rate-limit-stack);
 * композиция позволяет реиспользовать его с теми же зависимостями
 * (`RedisService` + `Reflector`) без дублирования провайдера.
 *
 * Объявлен ДО `ScreenshotTokenController`, чтобы декоратор
 * `@UseGuards(ScreenshotTokenRateLimitGuard)` имел корректную ссылку
 * на класс на момент load файла (TS-class hoisting не работает для
 * `class` на уровне модуля).
 */
@Injectable()
export class ScreenshotTokenRateLimitGuard implements CanActivate {
  private readonly logger = new Logger('ScreenshotTokenRateLimitGuard');
  private readonly inner: RedisRateLimitGuard;

  constructor(redis: RedisService, reflector: Reflector) {
    this.inner = new RedisRateLimitGuard(redis, reflector);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    try {
      return await this.inner.canActivate(ctx);
    } catch (err) {
      if (
        err instanceof HttpException &&
        err.getStatus() === HttpStatus.TOO_MANY_REQUESTS
      ) {
        const req = ctx.switchToHttp().getRequest<Request>();
        this.logger.warn(
          JSON.stringify({
            event: 'screenshot_token',
            outcome: 'rate_limited',
            ip: readClientIp(req),
            userAgent: readUserAgent(req),
          }),
        );
      }
      throw err;
    }
  }
}

/**
 * KS-2303 / KS-2305 — SCR2 (ADR-039 §4, screenshot tooling E1).
 *
 * Внутренний endpoint выдачи JWT для зарегистрированного техаккаунта
 * `__screenshot_agent` (KS-2257 seed).
 *
 * Контракт:
 *  - `POST /api/internal/screenshot-token` — **без авторизации**, чтобы
 *    screenshot-tool мог обращаться без знания паролей/секретов.
 *  - Защита злоупотребления — IP-rate-limit `10 req / 60s` через
 *    `ScreenshotTokenRateLimitGuard` (обёртка над `RedisRateLimitGuard`,
 *    добавляет structured-log на 429-исход; см. KS-2305).
 *  - Body нет: endpoint всегда выдаёт токен **фиксированному**
 *    пользователю (`username = '__screenshot_agent'`).
 *  - 503, если аккаунта нет в БД (seed не запущен / удалён).
 *  - JWT-payload `{ sub, username }`. TTL 15 мин (`JWT_EXPIRES_IN`).
 *
 * Аудит / метрики (KS-2305, ADR-039 §4):
 *  - structured-log (одна JSON-строка на исход) с полями
 *    `event=screenshot_token`, `outcome` (issued/no_account/rate_limited),
 *    `ip`, `userAgent`, `tokenHash` (только для issued). Самого токена
 *    в логах нет.
 *  - Prometheus counter `screenshot_token_issued_total{ip}` —
 *    инкрементируется только на `issued`. `MetricsService` приходит
 *    через `@Optional()`-инъекцию: если в проекте Prometheus не
 *    подключён (например, в тестовом миниприложении без
 *    `MetricsModule`), счётчик пропускается без падения.
 *  - rate-limit-исходы логируются `ScreenshotTokenRateLimitGuard`
 *    (см. ниже) — контроллер до них не доходит.
 *
 * Аудит-таблица не нужна: события выдачи попадают в stdout-лог
 * (`api-stdout.log` в dev / CloudWatch в prod).
 */
@Controller('internal')
export class ScreenshotTokenController {
  private readonly logger = new Logger(ScreenshotTokenController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    @Optional()
    @Inject(MetricsService)
    private readonly metrics?: MetricsService,
  ) {}

  @Post('screenshot-token')
  @UseGuards(ScreenshotTokenRateLimitGuard)
  @RateLimit(10, 60)
  async issueScreenshotToken(
    @Req() req: Request,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const requesterIp = readClientIp(req);
    const userAgent = readUserAgent(req);

    const user = await this.prisma.user.findFirst({
      where: { username: SCREENSHOT_AGENT_USERNAME },
      select: { id: true, username: true },
    });

    if (!user) {
      this.logger.warn(
        JSON.stringify({
          event: 'screenshot_token',
          outcome: 'no_account',
          ip: requesterIp,
          userAgent,
          username: SCREENSHOT_AGENT_USERNAME,
        }),
      );
      // 503 — ops issue, не invalid request: client может отретраить
      // через минуту-час; код 4xx был бы вводящим в заблуждение.
      throw new ServiceUnavailableException(
        'screenshot account is not provisioned',
      );
    }

    const expiresInSec = parseExpiresInSeconds(
      this.config.get<string>('JWT_EXPIRES_IN', '15m'),
    );

    const accessToken = this.jwtService.sign(
      { sub: user.id, username: user.username },
      { expiresIn: expiresInSec },
    );

    const tokenHash = sha256(accessToken);
    this.logger.log(
      JSON.stringify({
        event: 'screenshot_token',
        outcome: 'issued',
        ip: requesterIp,
        userAgent,
        tokenHash,
        userId: user.id,
        expiresIn: expiresInSec,
      }),
    );

    // Prometheus метрика — опционально (если Prometheus подключён через
    // MetricsModule). Контракт: один counter `screenshot_token_issued_total`
    // с label `ip` (см. ADR-039 §4 / KS-2305).
    this.metrics?.incScreenshotTokenIssued(requesterIp);

    return { accessToken, expiresIn: expiresInSec };
  }
}

function readClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip ?? 'unknown';
}

function readUserAgent(req: Request): string {
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string' && ua.length > 0) return ua;
  return 'unknown';
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
