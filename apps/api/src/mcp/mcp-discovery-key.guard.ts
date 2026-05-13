/**
 * KS-2952 / ADR-061 §5 уровень 5 + §6 «Auth для /_mcp/tools».
 *
 * Защищает `/_mcp/tools` shared-secret заголовком `X-Mcp-Discovery-Key`.
 *
 * Поведение:
 *  - `NODE_ENV !== 'production'` — guard разрешает запрос без ключа,
 *    чтобы локально не возиться (см. ADR §6 «В dev — без ключа»);
 *  - `process.env.MCP_DISCOVERY_KEY` не задан в проде — 403 (мы не хотим
 *    случайно открыть каталог при пустом env, см. паттерн `InternalKeyGuard`);
 *  - заголовок отсутствует / не совпадает — 403 без подсказок;
 *  - совпадает constant-time → allow.
 *
 * Сравнение через `crypto.timingSafeEqual` — защита от timing-attack
 * (паттерн `InternalKeyGuard`, KS-2182).
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';

export const MCP_DISCOVERY_HEADER = 'x-mcp-discovery-key';

@Injectable()
export class McpDiscoveryKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const nodeEnv =
      this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
    if (nodeEnv !== 'production') return true;

    const expected = this.config.get<string>('MCP_DISCOVERY_KEY');
    if (!expected) {
      throw new ForbiddenException();
    }

    const req = ctx.switchToHttp().getRequest<Request>();
    const provided = req.headers[MCP_DISCOVERY_HEADER];
    if (typeof provided !== 'string' || provided.length === 0) {
      throw new ForbiddenException();
    }

    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) throw new ForbiddenException();
    if (!crypto.timingSafeEqual(a, b)) throw new ForbiddenException();

    return true;
  }
}
