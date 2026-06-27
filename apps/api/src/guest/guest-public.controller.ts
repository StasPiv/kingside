/**
 * KS-4700 / ADR-147 §6.2. Публичный endpoint выдачи подписанных
 * consent-cookies гостю. Решает зазор архитектуры T1c/T4: фронт может
 * читать `analytics_consent` (без HttpOnly), но подпись
 * `analytics_consent_sig` создать не может (HMAC-секрет только на
 * бэке). Без подписи `GuestIdMiddleware` no-op, `guest_id` не
 * выпускается, `POST /events` от гостя проваливается.
 *
 *   POST /guest/consent { analytics: true }
 *     → Set-Cookie: analytics_consent=1; …
 *     → Set-Cookie: analytics_consent_sig=<HMAC>; …; HttpOnly
 *     → Set-Cookie: guest_id=<uuid>.<HMAC>; …
 *     → 200 { analytics: true, guestIssued: true }
 *
 *   POST /guest/consent { analytics: false }
 *     → Set-Cookie: …=; Max-Age=0  (для всех трёх cookie)
 *     → 200 { analytics: false, guestIssued: false }
 *
 *   POST /guest/consent с Bearer-токеном
 *     → 405 (используй PATCH /me/consent)
 *
 * Защита: `IpRateLimitGuard` (10/мин/IP, переиспользуем общий лимит
 * от `/logs` и `/events`). Без auth-guard — это публичный endpoint
 * для не-юзера.
 *
 * НЕ часть `GuestController` (тот висит под class-`GuestIdGuard`,
 * который как раз требует уже выпущенный `guest_id` — для consent-
 * endpoint'а это противоречие).
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  MethodNotAllowedException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { IsBoolean } from 'class-validator';
import type { Request, Response } from 'express';
import { IpRateLimitGuard } from '../client-logs/ip-rate-limit.guard';
import { GuestCookieSigner } from '../common/guest-cookie-signer';
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_SIG_COOKIE,
  GUEST_ID_COOKIE,
} from '../events/events.types';
import { EventsMetricsService } from '../events/events-metrics.service';

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export class UpdateGuestConsentDto {
  @IsBoolean()
  analytics!: boolean;
}

interface ConsentResponse {
  analytics: boolean;
  /** true — если этим ответом выпущен новый `guest_id`. */
  guestIssued: boolean;
}

@UseGuards(IpRateLimitGuard)
@Controller('guest')
export class GuestPublicController {
  private readonly logger = new Logger(GuestPublicController.name);
  private readonly signer: GuestCookieSigner;
  private readonly isProduction: boolean;

  constructor(
    config: ConfigService,
    private readonly metrics: EventsMetricsService,
  ) {
    const secret =
      config.get<string>('GUEST_COOKIE_SECRET')
      ?? config.get<string>('JWT_SECRET')
      ?? '';
    this.signer = new GuestCookieSigner(secret);
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
  }

  @Post('consent')
  @HttpCode(HttpStatus.OK)
  consent(
    @Body() body: UpdateGuestConsentDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): ConsentResponse {
    // Bearer-юзер → у него есть PATCH /me/consent. Не дублируем
    // механизм, чтобы guest-cookie не «застряло» в браузере у
    // авторизованного пользователя.
    if (typeof req.headers.authorization === 'string'
      && req.headers.authorization.toLowerCase().startsWith('bearer ')) {
      throw new MethodNotAllowedException(
        'authenticated users must use PATCH /me/consent',
      );
    }

    if (!body.analytics) {
      this.expireConsentCookies(res);
      return { analytics: false, guestIssued: false };
    }

    // analytics=true. Подписываем сразу всё, что нужно
    // GuestIdMiddleware для последующих запросов:
    //   - analytics_consent='1' (читаемый, без HttpOnly).
    //   - analytics_consent_sig=HMAC('1') (HttpOnly — клиенту читать
    //     незачем; только бэк проверяет middleware'ом).
    //   - guest_id=<uuid>.<HMAC(uuid)> — чтобы фронту не пришлось
    //     ходить ещё раз, ждать пока middleware подцепит и выпишет
    //     guest_id на следующем запросе.
    this.setCookie(res, ANALYTICS_CONSENT_COOKIE, '1', { httpOnly: false });
    const sig = this.signer.sign('1');
    this.setCookie(res, ANALYTICS_CONSENT_SIG_COOKIE, sig, { httpOnly: true });

    const guestId = randomUUID();
    const guestCookieValue = this.signer.signCombined(guestId);
    this.setCookie(res, GUEST_ID_COOKIE, guestCookieValue, { httpOnly: false });
    this.metrics.incGuestIdIssued();

    this.logger.log(`/guest/consent analytics=true guest_id=${guestId}`);
    return { analytics: true, guestIssued: true };
  }

  private expireConsentCookies(res: Response): void {
    for (const name of [
      ANALYTICS_CONSENT_COOKIE,
      ANALYTICS_CONSENT_SIG_COOKIE,
      GUEST_ID_COOKIE,
    ]) {
      const parts = [`${name}=`, 'Path=/', 'Max-Age=0', 'SameSite=Lax'];
      if (this.isProduction) parts.push('Secure');
      res.append('Set-Cookie', parts.join('; '));
    }
  }

  private setCookie(
    res: Response,
    name: string,
    value: string,
    opts: { httpOnly: boolean },
  ): void {
    const parts = [
      `${name}=${value}`,
      'Path=/',
      `Max-Age=${ONE_YEAR_SECONDS}`,
      'SameSite=Lax',
    ];
    if (this.isProduction) parts.push('Secure');
    if (opts.httpOnly) parts.push('HttpOnly');
    res.append('Set-Cookie', parts.join('; '));
  }
}
