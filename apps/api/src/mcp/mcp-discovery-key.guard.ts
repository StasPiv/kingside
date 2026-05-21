/**
 * KS-2952 / ADR-061 §5 уровень 5 + §6 «Auth для /_mcp/tools».
 *
 * Опциональная защита `/_mcp/tools` shared-secret заголовком
 * `X-Mcp-Discovery-Key`.
 *
 * Поведение (KS-3218: ослаблено):
 *  - `NODE_ENV !== 'production'` — guard разрешает запрос без ключа
 *    (см. ADR §6 «В dev — без ключа»);
 *  - `process.env.MCP_DISCOVERY_KEY` **не задан** в проде → guard
 *    становится no-op и разрешает запрос (раньше было 403). Каталог
 *    tools — это имена + JSON-schema endpoint'ов, секретов в нём нет;
 *    реальное выполнение каждого tool'а защищено JwtAuthGuard +
 *    Bearer-токеном пользователя. Если admin хочет закрыть каталог
 *    публичности — задайте `MCP_DISCOVERY_KEY` в env, и guard снова
 *    станет mandatory.
 *  - `MCP_DISCOVERY_KEY` **задан** в проде:
 *      • заголовок отсутствует / не совпадает → 403 без подсказок;
 *      • совпадает constant-time → allow.
 *
 * Сравнение через `crypto.timingSafeEqual` — защита от timing-attack
 * (паттерн `InternalKeyGuard`, KS-2182). При совпадении длин: один
 * вызов compare, иначе 403 (length mismatch).
 *
 * KS-3218: причина ослабления — внешний MCP-клиент (webhook-server.py)
 * на нашем хосте не имеет возможности прокинуть ключ через своё env
 * (инфра в зоне пользователя, не задеплоить). Без discovery webhook
 * передаёт пустой `--allowedTools` claude CLI'ю → новые `@McpTool` к
 * ассистенту не попадают. Безопасность не страдает: имена/пути
 * tools — публичная информация (фронт всё равно их показывает в UI и
 * /docs), а POST/GET на сами endpoint'ы по-прежнему требует JWT.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';

export const MCP_DISCOVERY_HEADER = 'x-mcp-discovery-key';

@Injectable()
export class McpDiscoveryKeyGuard implements CanActivate {
  private readonly logger = new Logger('McpDiscoveryKeyGuard');
  private warnedOnce = false;

  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const nodeEnv =
      this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
    if (nodeEnv !== 'production') return true;

    const expected = this.config.get<string>('MCP_DISCOVERY_KEY');
    if (!expected) {
      // KS-3218: env-ключ не задан → каталог tools публично читаемый.
      // Логируем один раз при старте, чтобы admin знал состояние.
      if (!this.warnedOnce) {
        this.logger.warn(
          'MCP_DISCOVERY_KEY is not set — /_mcp/tools is publicly readable. ' +
            'Set the env var to require X-Mcp-Discovery-Key header.',
        );
        this.warnedOnce = true;
      }
      return true;
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
