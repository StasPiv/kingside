/**
 * KS-4455 / ADR-139 §3. Композитный гард: успех, если прошла одна из
 * двух цепочек аутентификации.
 *
 *   B (service-account, проверяется первой по префиксу `ks_sa_`):
 *     `ServiceAccountGuard`. Если префикс есть → лезем в БД. Если
 *     запись не найдена/отозвана → 401 без падения в JWT-цепочку
 *     (иначе можно засветить «токен есть, но просрочен» через
 *     несовпадение кодов).
 *
 *   A (human-admin, fallback):
 *     `JwtAuthGuard` → `AdminUserGuard` (whitelist `KS_ADMIN_USERS`).
 *     Используется когда B вернула `false` — значит токен не
 *     `ks_sa_*`-формата (либо вовсе нет Bearer-заголовка).
 *
 * Scope-проверка (`@RequiredScope`):
 *   * service-account → `hasScope(req.user.scopes, required)`, иначе 403;
 *   * JWT-admin → scope игнорируется (human-админ может всё).
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminUserGuard } from './admin-user.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  REQUIRED_SCOPE_METADATA,
  hasScope,
} from './required-scope.decorator';
import { ServiceAccountGuard } from './service-account.guard';

interface AuthRequest {
  user?: {
    isServiceAccount?: boolean;
    scopes?: string[];
  };
}

@Injectable()
export class AdminOrServiceGuard implements CanActivate {
  constructor(
    private readonly serviceGuard: ServiceAccountGuard,
    private readonly jwtGuard: JwtAuthGuard,
    private readonly adminGuard: AdminUserGuard,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const requiredScope = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_SCOPE_METADATA,
      [ctx.getHandler(), ctx.getClass()],
    );

    // ── ветка B: service-account ──
    let serviceOk: boolean;
    try {
      const result = await this.serviceGuard.canActivate(ctx);
      serviceOk = result === true;
    } catch (err) {
      // ServiceAccountGuard сам бросает 401 когда префикс был, но
      // запись невалидна. В композите это конечная ошибка — не
      // fall-through на JWT (иначе клиент с битым ks_sa_-токеном мог
      // бы получить 200 через подмешанный JWT, а это путаница в
      // аудите).
      throw err instanceof UnauthorizedException
        ? err
        : new UnauthorizedException('Service-account auth failed');
    }
    if (serviceOk) {
      if (requiredScope) {
        const req = ctx.switchToHttp().getRequest<AuthRequest>();
        const scopes = req.user?.scopes ?? [];
        if (!hasScope(scopes, requiredScope)) {
          throw new ForbiddenException(
            `Service-account is missing required scope: ${requiredScope}`,
          );
        }
      }
      return true;
    }

    // ── ветка A: JWT-admin ──
    // JwtAuthGuard внутри passport-jwt бросает UnauthorizedException
    // при провале — оборачиваем в `await` без try, чтобы 401 ушёл
    // клиенту как есть. AdminUserGuard тоже сам бросит 401/403.
    const jwtOk = await this.runMaybeAsync(this.jwtGuard.canActivate(ctx));
    if (!jwtOk) throw new UnauthorizedException();
    const adminOk = await this.runMaybeAsync(this.adminGuard.canActivate(ctx));
    if (!adminOk) throw new ForbiddenException();
    // Human-admin: scope игнорируется.
    return true;
  }

  /**
   * Унифицирует возвращаемое значение NestJS гарда (`boolean |
   * Promise<boolean> | Observable<boolean>`) к `Promise<boolean>`.
   * Observable от JwtAuthGuard на практике не приходит (passport-jwt
   * возвращает Promise), но защищаемся от регрессии.
   */
  private async runMaybeAsync(
    v: boolean | Promise<boolean> | { subscribe: unknown },
  ): Promise<boolean> {
    if (typeof v === 'boolean') return v;
    if (v instanceof Promise) return v;
    // Observable — конвертация через `firstValueFrom` была бы
    // правильнее, но добавлять `rxjs` ради ветки, которая в нашем
    // продакшене не срабатывает — overkill. Бросаем явно, чтобы
    // регрессия не утекла молча.
    throw new Error(
      'AdminOrServiceGuard: Observable canActivate is not supported',
    );
  }
}
