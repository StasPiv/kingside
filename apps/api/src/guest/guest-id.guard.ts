/**
 * KS-4697 / ADR-147 §6.3. Guard для `/guest/*` GDPR-эндпоинтов.
 * Принимает только запросы с валидным подписанным cookie `guest_id`,
 * который проставил `GuestIdMiddleware` (T1c, KS-4695). Middleware
 * сам подпишет — здесь только проверка наличия `req.guestId` после
 * него.
 *
 * Подпись cookie `guest_id` уже проверена в middleware (constant-time
 * HMAC compare). Здесь дублировать не надо: middleware-цепочка
 * выполняется перед guard'ом, и `req.guestId` появляется только при
 * валидной подписи.
 *
 * Альтернативный пользователь — JWT-юзер — отвергается: для него есть
 * `/me/*`-эндпоинты (`@UseGuards(JwtAuthGuard)`). Mix внутри одного
 * запроса не даёт смысла.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestWithGuest } from '../common/guest-id.middleware';

@Injectable()
export class GuestIdGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RequestWithGuest>();
    if (typeof req.headers.authorization === 'string'
      && req.headers.authorization.toLowerCase().startsWith('bearer ')) {
      // Это JWT-юзер — не наш кейс. /me/* endpoints его обслужат.
      throw new UnauthorizedException('use /me/* endpoints for authenticated users');
    }
    if (!req.guestId) {
      // Без consent middleware не выписывает guest_id → нет данных,
      // которые имеет смысл удалять/экспортировать.
      throw new UnauthorizedException(
        'no guest_id cookie — consent required first',
      );
    }
    return true;
  }
}
