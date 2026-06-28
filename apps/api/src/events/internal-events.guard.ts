/**
 * KS-4748 / ADR-149 G2. HMAC-аутентификация для `POST /internal/events`.
 *
 * Контракт:
 *   - Заголовок `X-Internal-Signature: <hex>` — `hmac-sha256(rawBody, INTERNAL_EVENTS_SECRET)`.
 *   - Без env-var `INTERNAL_EVENTS_SECRET` → 503 (endpoint disabled).
 *   - Подпись неверна / заголовок отсутствует → 401.
 *   - Сравнение через `crypto.timingSafeEqual` — защита от timing-атак.
 *
 * Raw body берётся из `req.rawBody` (см. `main.ts`, `json({verify})`).
 * Без rawBody guard падает 500 — это конфиг-ошибка приложения, не клиента.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export const INTERNAL_EVENTS_SIGNATURE_HEADER = 'x-internal-signature';

@Injectable()
export class InternalEventsGuard implements CanActivate {
  private readonly logger = new Logger(InternalEventsGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.INTERNAL_EVENTS_SECRET;
    if (!secret) {
      throw new ServiceUnavailableException(
        'POST /internal/events disabled: INTERNAL_EVENTS_SECRET not set',
      );
    }

    const req = context.switchToHttp().getRequest<{
      rawBody?: Buffer;
      headers: Record<string, string | string[] | undefined>;
    }>();

    const header = req.headers[INTERNAL_EVENTS_SIGNATURE_HEADER];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature || typeof signature !== 'string') {
      throw new UnauthorizedException('missing X-Internal-Signature');
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      // Body-parser не выставил rawBody — конфиг приложения сломан.
      this.logger.error(
        'rawBody missing — body-parser not configured with verify (see main.ts)',
      );
      throw new UnauthorizedException('invalid request');
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    let provided: Buffer;
    let computed: Buffer;
    try {
      provided = Buffer.from(signature, 'hex');
      computed = Buffer.from(expected, 'hex');
    } catch {
      throw new UnauthorizedException('invalid signature format');
    }
    if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
      throw new UnauthorizedException('invalid signature');
    }
    return true;
  }
}
