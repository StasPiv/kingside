import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * KS-2815 / KS-2819 T4. Опциональный JWT-guard для эндпоинтов с
 * двойной видимостью: authenticated owner может читать приватный
 * ресурс, anonymous — только публичный.
 *
 * Если JWT валиден — заполняет `req.user`. Если токена нет / он
 * битый — оставляет `req.user = undefined` и пропускает запрос
 * дальше; visibility-проверку делает `StudyAccessGuard`.
 *
 * Реализация: наследуется от `AuthGuard('jwt')` и переопределяет
 * `handleRequest` — стандартная реализация бросает 401 при отсутствии
 * `user`. Мы возвращаем `null` без бросания.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<T = unknown>(_err: unknown, user: T): T | null {
    // Не бросаем 401 при ошибке/отсутствии — это «опциональный» режим.
    // err от passport нам тут безразличен: либо у нас есть user, либо нет.
    return user ?? null;
  }

  // Контракт canActivate базового AuthGuard ловит исключения из
  // strategy.validate; даже если passport кинет — handleRequest
  // выше нормализует в null, и Nest пустит запрос дальше.
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      /* swallow: anonymous request allowed */
    }
    return true;
  }
}
