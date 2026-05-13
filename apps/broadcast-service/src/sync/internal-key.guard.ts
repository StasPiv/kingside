/**
 * KS-2883 / ADR-060 §3.7 B10. Защита internal-эндпоинтов broadcast-service'а
 * (которые дёргает только `apps/api` для broadcast-зеркала студии).
 *
 * Паттерн `apps/api/src/auth/internal-key.guard.ts` (KS-2182): один
 * shared-secret `SYNTHETIC_BOT_INTERNAL_KEY` в env, проверяется через
 * constant-time-сравнение.
 *
 * Поведение:
 *  - ENV не задан → 503/UnauthorizedException (как у api-варианта). На
 *    health-check'е инстанс отсекается.
 *  - Заголовок отсутствует / не совпадает → 401/403.
 *  - Совпадает → allow.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';
import { INTERNAL_AUTH_HEADER } from '@kingside/shared';

@Injectable()
export class InternalKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalKeyGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected =
      this.config.get<string>('SYNTHETIC_BOT_INTERNAL_KEY') ??
      process.env.SYNTHETIC_BOT_INTERNAL_KEY;
    if (!expected) {
      this.logger.error(
        'SYNTHETIC_BOT_INTERNAL_KEY is not set — rejecting all /internal/* requests',
      );
      throw new UnauthorizedException('Internal endpoint disabled');
    }
    const req = ctx.switchToHttp().getRequest<Request>();
    const headerName = INTERNAL_AUTH_HEADER.toLowerCase();
    const provided = req.headers[headerName];
    const value =
      typeof provided === 'string'
        ? provided
        : Array.isArray(provided)
          ? provided[0]
          : undefined;
    if (!value) {
      throw new UnauthorizedException('Missing internal auth header');
    }
    const a = Buffer.from(value, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) throw new ForbiddenException();
    if (!crypto.timingSafeEqual(a, b)) throw new ForbiddenException();
    return true;
  }
}
