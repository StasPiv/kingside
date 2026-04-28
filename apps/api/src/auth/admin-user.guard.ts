import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest } from '../common/authenticated-request';

/**
 * KS-2108 — админ-доступ по `username` из ENV-whitelist `KS_ADMIN_USERS`.
 *
 * Замена `AdminEmailGuard`-style проверки для админ-страницы feature
 * flags. Username стабильнее email-а (email опционален, может меняться;
 * у некоторых пользователей его нет совсем — например, telegram-bypass).
 *
 * Поведение:
 *  - ENV пустая или не задана → deny (`ForbiddenException`).
 *  - `KS_ADMIN_USERS=*` → allow всех аутентифицированных (только dev,
 *    в prod не использовать).
 *  - `KS_ADMIN_USERS=Alice,Bob` → allow только указанных. Сравнение —
 *    case-insensitive (PostgreSQL `User.username` тоже не enforces
 *    casing).
 *
 * Гард ставится ПОСЛЕ `JwtAuthGuard`. Без `req.user` → `UnauthorizedException`
 * (конфигурационная ошибка контроллера, а не «не админ»).
 *
 * Username читаем из БД по `userId` — JWT-strategy кладёт его в `req.user`,
 * но БД всё равно тянем как канонический источник (`User.username`
 * unique-constrainted и не меняется при обновлении токена).
 */
@Injectable()
export class AdminUserGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException();
    }

    const whitelist = parseAdminUsers(this.config.get<string>('KS_ADMIN_USERS'));
    if (whitelist.length === 0) {
      throw new ForbiddenException('Admin access disabled');
    }
    if (whitelist.includes('*')) return true;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    const username = user?.username;
    if (!username) {
      throw new ForbiddenException('Admin access denied');
    }
    if (!whitelist.includes(username.toLowerCase())) {
      throw new ForbiddenException('Admin access denied');
    }
    return true;
  }
}

/**
 * Service-level helper для проверки «is this user an admin?» без
 * выбрасывания ошибки. Используется `GET /api/profile/me/admin-status`,
 * где не-админ должен получить `{ isAdmin: false }`, а не 403.
 */
@Injectable()
export class AdminUserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async isAdmin(userId: string): Promise<boolean> {
    const whitelist = parseAdminUsers(this.config.get<string>('KS_ADMIN_USERS'));
    if (whitelist.length === 0) return false;
    if (whitelist.includes('*')) return true;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    const username = user?.username;
    if (!username) return false;
    return whitelist.includes(username.toLowerCase());
  }
}

/** Парсит CSV в нормализованный массив (lowercase, без пустых/пробелов). */
export function parseAdminUsers(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
