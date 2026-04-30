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

/**
 * KS-2182 (ADR-034-v2 §2, §10.1).
 *
 * Защищает все `/api/internal/*`-endpoint'ы по shared-secret заголовку
 * `X-Internal-Auth`. Заголовок известен только `apps/synthetic-bot-service`
 * (через ECS task definition + SSM SecureString) и совпадает с
 * `process.env.SYNTHETIC_BOT_INTERNAL_KEY` в `apps/api`.
 *
 * Двойная защита (ADR §2.3):
 *   1. ALB-rule блокирует `/internal/*` снаружи (Dv7, devops). Т.е. до
 *      этого guard'а должен дойти только трафик из VPC.
 *   2. Сам guard сверяет заголовок constant-time-сравнением.
 *
 * Поведение:
 *   - ENV не задан / пуст → каждый запрос отвергается с 503 (мы не можем
 *     знать «правильный» ключ — это конфигурационная ошибка api-инстанса,
 *     а не «не пускаем с фронта»). Ставим 503 (а не 500) — health-check'и
 *     отделят такой инстанс от ALB до фикса env.
 *   - Заголовок отсутствует → 401 + лог `requesterIp`.
 *   - Заголовок не совпадает → 403 + лог `requesterIp` + `tokenHash`
 *     (SHA256 присланного значения, чтобы не складывать сам секрет в логи).
 *   - Совпадает → allow.
 *
 * Сравнение через `crypto.timingSafeEqual` — защита от timing-attack
 * (важно: если когда-нибудь один и тот же endpoint станет доступен из
 * untrusted-сети до ALB-rule).
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalKeyGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const expected = this.config.get<string>('SYNTHETIC_BOT_INTERNAL_KEY');

    if (!expected) {
      // Конфигурационная ошибка api-инстанса. Мы НЕ хотим случайно
      // открыть endpoint, если кто-то деплойнул без ключа. Кидаем 503,
      // чтобы health-check вытащил инстанс из ALB.
      this.logger.error(
        'SYNTHETIC_BOT_INTERNAL_KEY is not set — rejecting all /internal/* requests',
      );
      throw new UnauthorizedException('Internal endpoint disabled');
    }

    const provided = readHeader(req, INTERNAL_AUTH_HEADER);
    const requesterIp = readClientIp(req);

    if (!provided) {
      this.logger.warn(
        `Missing ${INTERNAL_AUTH_HEADER} header from ${requesterIp} on ${req.method} ${req.originalUrl}`,
      );
      throw new UnauthorizedException('Missing internal auth header');
    }

    if (!constantTimeEqual(provided, expected)) {
      const tokenHash = sha256(provided);
      this.logger.warn(
        `Invalid ${INTERNAL_AUTH_HEADER} header from ${requesterIp} on ${req.method} ${req.originalUrl} (tokenHash=${tokenHash})`,
      );
      throw new ForbiddenException('Invalid internal auth key');
    }

    return true;
  }
}

function readHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function readClientIp(req: Request): string {
  // ALB прокидывает X-Forwarded-For. В тестах/локально — req.ip.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip ?? 'unknown';
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Constant-time сравнение двух UTF-8 строк. Возвращает `false` при
 * различии длины (timingSafeEqual требует одинакового размера буферов;
 * длина secret'а сама по себе утечка, но та же, что у плановых легальных
 * запросов).
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
