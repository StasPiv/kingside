import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest } from '../common/authenticated-request';

/**
 * KS-1963 (admin API B-1).
 *
 * Допускает к роуту только пользователей, чей email указан в
 * ENV-whitelist `LESSON_ADMIN_EMAILS` (CSV, case-insensitive).
 * Зеркало фронтового `isEmailAllowedForEditor` — концепт
 * KS-1962 §4.
 *
 * Поведение:
 *  - ENV пустая или не задана → deny (`ForbiddenException`).
 *  - `LESSON_ADMIN_EMAILS=*` → allow всех аутентифицированных
 *    (только для dev — не помещай `*` в prod).
 *  - `LESSON_ADMIN_EMAILS=a@x,b@y` → allow только указанных,
 *    сравнение по нижнему регистру.
 *
 * Должен ставиться ПОСЛЕ `JwtAuthGuard` — гард предполагает, что
 * passport уже положил `req.user`. Без `req.user` (то есть JwtAuthGuard
 * не сработал) кидаем `UnauthorizedException` — отдельный код, чтобы
 * это можно было отличить в логах от «не админ».
 *
 * Email берётся из БД по `userId`, а не из JWT-claim'а: в текущей
 * `JwtStrategy.validate` email не возвращается, и тащить его в JWT
 * ради админ-роутов — лишняя инвалидация существующих токенов
 * пользователей. Один SELECT по PK — дёшево.
 */
@Injectable()
export class AdminEmailGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = req.user?.id;
    if (!userId) {
      // JwtAuthGuard должен отрабатывать раньше; если мы здесь без user —
      // это конфигурационная ошибка контроллера, а не «не админ».
      throw new UnauthorizedException();
    }

    const whitelist = parseAdminEmails(process.env.LESSON_ADMIN_EMAILS);
    if (whitelist.length === 0) {
      throw new ForbiddenException('Admin access disabled');
    }

    // Wildcard: пускаем без подгрузки email — экономим запрос. Это
    // dev-режим, в prod так не ставить.
    if (whitelist.includes('*')) return true;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const email = user?.email;
    if (!email) {
      throw new ForbiddenException('Admin access denied');
    }
    if (!whitelist.includes(email.toLowerCase())) {
      throw new ForbiddenException('Admin access denied');
    }
    return true;
  }
}

/**
 * Парсит CSV-список email'ов из ENV в нормализованный массив (lowercase,
 * без пустых, без пробелов). Экспортируется отдельно — чтобы spec-тесты
 * могли проверить парсинг изолированно.
 */
export function parseAdminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
