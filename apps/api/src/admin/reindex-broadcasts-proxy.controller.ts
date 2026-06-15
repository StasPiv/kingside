/**
 * KS-4221. Public-edge proxy для разового admin-эндпоинта
 * broadcast-service'а. Сам broadcast-service не выставлен наружу —
 * только внутри AWS-сети (env `BROADCAST_SERVICE_URL`), а
 * реиндексацию нужно запустить разово через публичный URL.
 *
 * Защита та же — token в `X-Admin-Token`. apps/api проверяет, что
 * клиент знает токен, и форвардит запрос в broadcast-service с тем же
 * заголовком. broadcast-service повторно проверяет токен — двойная
 * защита.
 */

import {
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('admin/prerender/reindex')
export class ReindexBroadcastsProxyController {
  private readonly logger = new Logger(ReindexBroadcastsProxyController.name);

  constructor(private readonly config: ConfigService) {}

  @Post('broadcasts')
  async reindexBroadcasts(
    @Headers('x-admin-token') token: string | undefined,
  ): Promise<unknown> {
    const expected = this.config.get<string>('BROADCAST_ADMIN_TOKEN');
    if (!expected || !expected.trim()) {
      throw new HttpException(
        'admin endpoint is not configured (BROADCAST_ADMIN_TOKEN missing on api)',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!token || token !== expected) {
      throw new HttpException('forbidden', HttpStatus.FORBIDDEN);
    }
    const url = this.config.get<string>('BROADCAST_SERVICE_URL');
    if (!url || !url.trim()) {
      throw new HttpException(
        'BROADCAST_SERVICE_URL is not configured on api',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const target = `${url.replace(/\/+$/, '')}/admin/prerender/reindex/broadcasts`;
    this.logger.log(`[reindex-proxy] forwarding to ${target}`);
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: {
          'X-Admin-Token': token,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
      if (!res.ok) {
        this.logger.error(
          `[reindex-proxy] broadcast-service responded HTTP ${res.status}: ${text}`,
        );
        throw new HttpException(
          { upstream: res.status, body },
          HttpStatus.BAD_GATEWAY,
        );
      }
      this.logger.log(`[reindex-proxy] done: ${text}`);
      return body;
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new HttpException(
        `proxy fetch failed: ${(e as Error).message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
