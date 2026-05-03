import {
  Controller,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  RateLimit,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { parseExpiresInSeconds } from './internal-auth.controller';
import { SCREENSHOT_AGENT_USERNAME } from '../scripts/seed-screenshot-account';

/**
 * KS-2303 / SCR2 (ADR-039 §4, screenshot tooling E1).
 *
 * Внутренний endpoint выдачи JWT для зарегистрированного техаккаунта
 * `__screenshot_agent` (см. KS-2257 — seed).
 *
 * Контракт:
 *  - `POST /api/internal/screenshot-token` — **без авторизации**, чтобы
 *    screenshot-tool мог обращаться без знания паролей/секретов.
 *  - Защита злоупотребления — IP-rate-limit `10 req / 60s` через
 *    `RedisRateLimitGuard` (стандартный rate-limit-stack проекта).
 *  - Body нет: endpoint всегда выдаёт токен **фиксированному**
 *    пользователю (`username = '__screenshot_agent'`). Этим
 *    исключается use-кейс «выдай мне токен любого user.id», который
 *    был у KS-2182 и закрыт `InternalKeyGuard`'ом.
 *  - 503, если аккаунта нет в БД (пока seed не запущен / удалён) —
 *    это ошибка ops-стороны, не клиентская; tool ретраит позже.
 *  - JWT-payload `{ sub, username }` идентичен обычному (см.
 *    `AuthService.generateTokens`). TTL 15 мин (`JWT_EXPIRES_IN`).
 *
 * Логирование (ADR-039 §4 / по образцу `InternalAuthController`): ip,
 * user-agent, tokenHash (SHA-256 свежевыданного access-токена). Самого
 * токена в логах нет.
 *
 * Аудит-таблица не нужна — событие выдачи логируется ровно один раз
 * на запрос; все ip+ua записи попадают в стандартный stdout-лог
 * (api-stdout.log в dev / CloudWatch в prod).
 */
@Controller('internal')
export class ScreenshotTokenController {
  private readonly logger = new Logger(ScreenshotTokenController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  @Post('screenshot-token')
  @UseGuards(RedisRateLimitGuard)
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
        `screenshot-token: account not seeded ` +
          `username=${SCREENSHOT_AGENT_USERNAME} ip=${requesterIp} ua="${userAgent}"`,
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
      `screenshot-token: issued userId=${user.id} ip=${requesterIp} ` +
        `ua="${userAgent}" tokenHash=${tokenHash} expiresIn=${expiresInSec}`,
    );

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
