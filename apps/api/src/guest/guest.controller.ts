/**
 * KS-4697 / ADR-147 §6.3. GDPR-эндпоинты для гостя (`actor_type='guest'`).
 *
 *   - `DELETE /guest/analytics-data` — Art. 17. После удаления данных
 *     сбрасывает cookies `guest_id` / `analytics_consent` /
 *     `analytics_consent_sig` (Max-Age=0). Дальнейшие запросы пойдут
 *     без actor — privacy by default.
 *   - `GET /guest/analytics-export` — Art. 20, streaming JSON,
 *     rate-limit 1/24ч.
 *
 * Защита:
 *   - `GuestIdGuard` — требует валидный `req.guestId` (проставляется
 *     `GuestIdMiddleware` только при наличии подписанного consent-cookie).
 *   - `IpRateLimitGuard` — переиспользуем тот же лимит, что у `/logs`
 *     и `/events` (5/мин/IP запрошено описанием задачи; текущий
 *     `IpRateLimitGuard` отдаёт 10/мин/IP — этого достаточно для
 *     одиночных операций GDPR, ужесточать без необходимости не будем).
 */
import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { IpRateLimitGuard } from '../client-logs/ip-rate-limit.guard';
import type { RequestWithGuest } from '../common/guest-id.middleware';
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_SIG_COOKIE,
  GUEST_ID_COOKIE,
} from '../events/events.types';
import { AnalyticsDataService } from '../events/analytics-data.service';
import { RedisService } from '../redis/redis.service';
import { consumeOnce, streamExportResponse } from '../me/me.controller';
import { GuestIdGuard } from './guest-id.guard';
import { ConfigService } from '@nestjs/config';

@UseGuards(IpRateLimitGuard, GuestIdGuard)
@Controller('guest')
export class GuestController {
  private readonly logger = new Logger(GuestController.name);
  private readonly cookieDomain: string | null;

  constructor(
    private readonly analyticsData: AnalyticsDataService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    // KS-4716: тот же Domain что у выпуска cookie (см. GuestPublicController).
    // Без него Set-Cookie с Max-Age=0 не «попадает» в cookie на правильном
    // домене и старая остаётся жить — для гостя это значит «нельзя
    // выйти из консента».
    this.cookieDomain = config.get<string>('COOKIE_DOMAIN') ?? null;
  }

  @Delete('analytics-data')
  @HttpCode(HttpStatus.OK)
  async deleteAnalytics(
    @Req() req: RequestWithGuest,
    @Res() res: Response,
  ): Promise<void> {
    const guestId = req.guestId!;
    const result = await this.analyticsData.deleteActorData({
      type: 'guest',
      id: guestId,
    });
    expireCookies(res, this.cookieDomain);
    this.logger.log(
      `/guest/analytics-data DELETE guest=${guestId} eventsDeleted=${result.eventsDeleted} aggKeysDeleted=${result.aggKeysDeleted} hintsKeysDeleted=${result.hintsKeysDeleted}`,
    );
    res.status(HttpStatus.OK).json(result);
  }

  @Get('analytics-export')
  async exportAnalytics(
    @Req() req: RequestWithGuest,
    @Res() res: Response,
  ): Promise<void> {
    const guestId = req.guestId!;
    const allowed = await consumeOnce(this.redis, `gdpr:export:guest:${guestId}`);
    if (!allowed) {
      throw new ForbiddenException(
        'analytics-export rate-limit: 1 request per 24h',
      );
    }
    await streamExportResponse(
      this.analyticsData,
      { type: 'guest', id: guestId },
      res,
    );
  }
}

function expireCookies(res: Response, domain: string | null): void {
  for (const name of [GUEST_ID_COOKIE, ANALYTICS_CONSENT_COOKIE, ANALYTICS_CONSENT_SIG_COOKIE]) {
    const parts = [`${name}=`, 'Path=/', 'Max-Age=0', 'SameSite=Lax'];
    if (domain) parts.push(`Domain=${domain}`);
    res.append('Set-Cookie', parts.join('; '));
  }
}
