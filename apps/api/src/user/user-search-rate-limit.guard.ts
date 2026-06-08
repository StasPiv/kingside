import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';

/**
 * KS-3938 / ADR-118 §2.4.1. In-memory rate-limit для
 * `GET /users/search` — 30 запросов в минуту на пользователя.
 *
 * Скользящего окна нет — фиксированное минутное «ведро» на каждый
 * userId; при превышении — `429 Too Many Requests`. Этого достаточно
 * для UI-поиска (пользователь печатает имя ученика); реальная атака
 * через массовый перебор имён не имеет смысла (профили уже публичные
 * через `/coaches/:username`).
 *
 * Per-process: при горизонтальном масштабировании сервиса каждая
 * task получит свой счётчик. Это намеренно — глобальный rate-limit
 * потребовал бы Redis-counter и оверхеда (см. ADR-118 §3.4: «никаких
 * новых переменных окружения, контейнеров»). При 2-4 task'ах
 * фактический лимит будет ×2..×4 от заявленного — приемлемая
 * погрешность для UI-help-rate-limit.
 *
 * Guard должен идти ПОСЛЕ `JwtAuthGuard` (чтобы `req.user.id` был
 * доступен). Для анонимных запросов (если бы прошли) — лимит ставится
 * на IP. JwtAuthGuard всё равно отсечёт anon до этого guard'а в
 * нормальной цепочке.
 */
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;

@Injectable()
export class UserSearchRateLimitGuard implements CanActivate {
  private readonly counters = new Map<
    string,
    { count: number; resetAt: number }
  >();

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();
    const key =
      req.user?.id ??
      (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        ?.trim() ??
      req.socket?.remoteAddress ??
      'unknown';

    const now = Date.now();
    const entry = this.counters.get(key);

    if (!entry || now >= entry.resetAt) {
      this.counters.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    if (entry.count >= MAX_REQUESTS) {
      throw new HttpException(
        'Too Many Requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    entry.count += 1;
    return true;
  }
}
