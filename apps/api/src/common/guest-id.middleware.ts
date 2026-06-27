/**
 * KS-4695 / ADR-147 §6.2. GuestIdMiddleware — присваивает гостям
 * стабильный подписанный идентификатор `guest_id` (UUID) в cookie.
 *
 * Алгоритм на каждом HTTP-запросе:
 *   1. Если есть валидный `Authorization: Bearer <jwt>` — это user,
 *      ничего не делаем (no-op).
 *   2. Иначе читаем cookie `analytics_consent` (значение `1`) +
 *      cookie `analytics_consent_sig` (HMAC). Без обоих + валидной
 *      подписи — no-op (без согласия не трекаем).
 *   3. Cookie `guest_id` уже есть и подпись валидна → продлеваем
 *      Max-Age (rolling) — `req.guestId = <uuid>` для downstream
 *      (EventsController).
 *   4. Cookie `guest_id` нет или подпись битая → генерируем новый
 *      UUID, подписываем, ставим Set-Cookie `guest_id=<uuid>.<sig>;
 *      Max-Age=31536000; SameSite=Lax; Secure; Path=/`. Увеличиваем
 *      счётчик `guest_id_issued_total`.
 *
 * Подпись:
 *   - HMAC-SHA256 секретом из env `GUEST_COOKIE_SECRET` (приоритет) или
 *     `JWT_SECRET` (fallback — он гарантированно есть в task-def).
 *   - Формат cookie value: `<uuid>.<base64url(hmac)>`.
 *
 * HttpOnly **не ставим** — фронт читает `guest_id` для отображения в
 * админ-целях (`<HintHost>`-нужды и debug). ADR-147 §6.2: «HttpOnly
 * не нужен — клиенту тоже надо читать для UI-state».
 *
 * Middleware monkey-patches `req.guestId: string | null` (через
 * глобальное расширение типа Request в events.types.ts? — нет, через
 * локальный type-augmentation в самом middleware ниже). Downstream
 * читает через `(req as ExpressRequestWithGuest).guestId`.
 */
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { EventsMetricsService } from '../events/events-metrics.service';
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_SIG_COOKIE,
  GUEST_ID_COOKIE,
} from '../events/events.types';
// KS-4700: подпись/проверка вынесены в отдельный модуль, чтобы
// GuestPublicController.consent использовал ту же реализацию.
import { GuestCookieSigner } from './guest-cookie-signer';

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

@Injectable()
export class GuestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(GuestIdMiddleware.name);
  private readonly secret: string;
  private readonly signer: GuestCookieSigner;
  private readonly isProduction: boolean;
  // KS-4716: cookies без Domain ставятся `api.kingside.site` (по умолчанию
  // domain'а ответа), фронт на `kingside.site` их не видит. Env
  // `COOKIE_DOMAIN=.kingside.site` на проде — общий ancestor.
  private readonly cookieDomain: string | null;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: EventsMetricsService,
  ) {
    this.secret =
      config.get<string>('GUEST_COOKIE_SECRET')
      ?? config.get<string>('JWT_SECRET')
      ?? '';
    this.signer = new GuestCookieSigner(this.secret);
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
    this.cookieDomain = config.get<string>('COOKIE_DOMAIN') ?? null;
    if (!this.secret) {
      this.logger.warn(
        'GUEST_COOKIE_SECRET и JWT_SECRET не заданы — подпись guest_id выключена, '
          + 'middleware всегда no-op (тесты/чистый dev).',
      );
    }
  }

  use(req: Request, res: Response, next: NextFunction): void {
    // 1. Авторизованный пользователь — middleware не трогает cookies.
    if (typeof req.headers.authorization === 'string'
      && req.headers.authorization.toLowerCase().startsWith('bearer ')) {
      next();
      return;
    }

    if (!this.secret) {
      // Без секрета не подписать → не выставить cookie. Идём дальше.
      next();
      return;
    }

    // 2. Проверка согласия.
    const cookies = parseCookies(req.headers.cookie);
    const consentValue = cookies[ANALYTICS_CONSENT_COOKIE];
    const consentSig = cookies[ANALYTICS_CONSENT_SIG_COOKIE];
    if (consentValue !== '1' || !consentSig
      || !this.verifySignature(consentValue, consentSig)) {
      next();
      return;
    }

    // 3+4. Проверка / выпуск guest_id.
    const existing = cookies[GUEST_ID_COOKIE];
    let guestId: string | null = null;
    if (existing) {
      const parsed = this.parseSignedValue(existing);
      if (parsed) guestId = parsed;
    }
    if (!guestId) {
      guestId = randomUUID();
      const signed = this.signValue(guestId);
      this.setCookie(res, GUEST_ID_COOKIE, signed);
      this.metrics.incGuestIdIssued();
    }

    (req as RequestWithGuest).guestId = guestId;
    next();
  }

  private signValue(value: string): string {
    return this.signer.signCombined(value);
  }

  /**
   * Парсит cookie вида `<value>.<base64url-sig>`. Возвращает value, если
   * подпись валидна, иначе null.
   */
  private parseSignedValue(combined: string): string | null {
    return this.signer.parseSignedCombined(combined);
  }

  /** Constant-time HMAC compare. */
  private verifySignature(value: string, sig: string): boolean {
    return this.signer.verify(value, sig);
  }

  private setCookie(res: Response, name: string, value: string): void {
    const parts = [
      `${name}=${value}`,
      'Path=/',
      `Max-Age=${ONE_YEAR_SECONDS}`,
      'SameSite=Lax',
    ];
    // KS-4716: общий ancestor для фронта (kingside.site) и бэка
    // (api.kingside.site).
    if (this.cookieDomain) parts.push(`Domain=${this.cookieDomain}`);
    if (this.isProduction) parts.push('Secure');
    // Без HttpOnly — см. шапку.
    res.append('Set-Cookie', parts.join('; '));
  }
}

/**
 * Локальный type-augmentation: расширяем тип `Request` полем
 * `guestId`. Объявляем здесь — middleware единственная точка, где оно
 * вписывается; controller читает через каст с тем же интерфейсом.
 */
export interface RequestWithGuest extends Request {
  guestId?: string | null;
}

/* ─── helpers ─────────────────────────────────────────────────── */

/**
 * Простой парсер `Cookie:` без зависимостей. Совместим с RFC 6265 в
 * пределах того, как cookie пишутся браузерами. Не парсит спец-символы
 * — нам не нужно.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    // Декодирование URI — типичная практика; cookie может содержать
    // percent-encoded символы.
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}
