/**
 * KS-4700 / ADR-147 §6.2. Утилита подписи/проверки cookie-values
 * HMAC-SHA256 секретом `GUEST_COOKIE_SECRET ?? JWT_SECRET`. Вынесена
 * из `GuestIdMiddleware`, чтобы `GuestPublicController.consent`
 * (выписывает `analytics_consent_sig` и `guest_id`) использовал
 * ровно те же подпись и проверку, что middleware — иначе подпись из
 * endpoint'а не проверится middleware-ом, и middleware не подцепит
 * `guest_id` на следующих запросах.
 *
 * Контракт подписи middleware:
 *   - `analytics_consent` value: строка `"1"` (не «name=value»).
 *     `analytics_consent_sig` = base64url(HMAC(secret, "1")).
 *   - `guest_id` value: `<uuid>.<base64url(HMAC(secret, <uuid>))>` —
 *     самодостаточная подпись внутри одного cookie.
 *
 * Один источник истины — этот файл; middleware импортирует те же
 * функции (см. KS-4700 refactor).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export class GuestCookieSigner {
  constructor(private readonly secret: string) {}

  /** `'1'` → `base64url(HMAC(secret, '1'))`. */
  sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  /** Constant-time compare. Возвращает true если sig валиден для value. */
  verify(value: string, sig: string): boolean {
    if (!this.secret || !sig) return false;
    const expected = this.sign(value);
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** Подписать `<value>` в формате `<value>.<sig>` — для `guest_id`. */
  signCombined(value: string): string {
    return `${value}.${this.sign(value)}`;
  }

  /** Распарсить `<value>.<sig>` → value если sig валиден; иначе null. */
  parseSignedCombined(combined: string): string | null {
    const dotIdx = combined.lastIndexOf('.');
    if (dotIdx <= 0 || dotIdx === combined.length - 1) return null;
    const value = combined.slice(0, dotIdx);
    const sig = combined.slice(dotIdx + 1);
    return this.verify(value, sig) ? value : null;
  }
}
