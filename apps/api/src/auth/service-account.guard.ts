/**
 * KS-4454 / ADR-139. Гард для machine-to-machine аутентификации
 * автономных агентов через сервисные аккаунты `AgentServiceAccount`
 * (T1 KS-4453).
 *
 * Контракт:
 *   * Клиент шлёт `Authorization: Bearer <plainToken>`.
 *   * `<plainToken>` начинается с префикса `ks_sa_` — иначе гард
 *     возвращает `false`, и контролю передаёт следующий гард в
 *     цепочке (обычно `JwtAuthGuard`).
 *   * `tokenHash = sha256(plainToken)` → lookup по
 *     `agent_service_accounts.token_hash` с `revoked_at IS NULL`.
 *     Не найдено / отозван / нет заголовка с префиксом → 401.
 *   * Успех: `req.user = { id, username: handle, isServiceAccount: true,
 *     scopes }`. Поля совместимы со схемой `AuthenticatedRequest.user`
 *     (id/username/email), плюс `isServiceAccount` и `scopes` —
 *     downstream-гарды (T3 `AdminOrServiceGuard` / `@RequiredScope`)
 *     различают типы аутентификации.
 *   * `lastUsedAt` обновляется fire-and-forget: ошибки логируются,
 *     основной запрос не блокируется и не падает.
 *
 * `isServiceAccount=false` для JWT-юзеров и `=true` для агентов —
 * единственный сигнал, по которому downstream-код понимает «это
 * человек или машина». Поле приходится класть в `req.user`, а не в
 * `req.serviceAccount`, чтобы вся остальная декорация (`@Request()`)
 * работала единообразно.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

export const SERVICE_ACCOUNT_PREFIX = 'ks_sa_';

export interface ServiceAccountAuthUser {
  /** AgentServiceAccount.id. */
  id: string;
  /** AgentServiceAccount.handle — переиспользуем поле `username`
   *  для совместимости с `AuthenticatedRequest`. */
  username: string;
  /** Маркер: гарды T3 будут различать JWT-пользователя и агента. */
  isServiceAccount: true;
  /** scopes из `agent_service_accounts.scopes`. */
  scopes: string[];
}

@Injectable()
export class ServiceAccountGuard implements CanActivate {
  private readonly logger = new Logger(ServiceAccountGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, unknown>;
      user?: ServiceAccountAuthUser;
    }>();

    const token = extractBearerToken(req.headers.authorization);
    if (token === null) {
      // Нет заголовка вообще или не Bearer — это не наш формат, пусть
      // дальше отрабатывает JwtAuthGuard.
      return false;
    }
    if (!token.startsWith(SERVICE_ACCOUNT_PREFIX)) {
      // Похоже на JWT — пропускаем.
      return false;
    }

    const tokenHash = sha256Hex(token);
    const account = await this.prisma.agentServiceAccount.findFirst({
      where: { tokenHash, revokedAt: null },
      select: {
        id: true,
        handle: true,
        scopes: true,
      },
    });
    if (!account) {
      // Префикс `ks_sa_` уже идентифицирует service-account-намерение;
      // отсутствие записи / отзыв — это явная ошибка авторизации,
      // не fall-through на JWT (иначе можно засветить «такой токен есть,
      // но просрочен» через несовпадение кодов ответа).
      throw new UnauthorizedException('Invalid service-account token');
    }

    req.user = {
      id: account.id,
      username: account.handle,
      isServiceAccount: true,
      scopes: account.scopes,
    };

    // Fire-and-forget: ошибка update не должна блокировать запрос.
    // Передаём `.catch` так, чтобы микротаск не превратился в
    // unhandled rejection и логи показывали детали.
    this.touchLastUsedAt(account.id);

    return true;
  }

  private touchLastUsedAt(id: string): void {
    void this.prisma.agentServiceAccount
      .update({
        where: { id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `lastUsedAt update failed for service-account id=${id}: ${msg}`,
        );
      });
  }
}

/**
 * Извлечь токен из заголовка `Authorization`. Возвращает `null`, если
 * заголовка нет либо схема не `Bearer`. На пустой/непечатный токен
 * тоже `null`.
 */
export function extractBearerToken(authorization: unknown): string | null {
  if (typeof authorization !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!m) return null;
  const token = m[1];
  return token.length > 0 ? token : null;
}

/** sha256 hex от plain-токена — единственная форма, в которой токен
 *  хранится в `agent_service_accounts.token_hash`. */
export function sha256Hex(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}
