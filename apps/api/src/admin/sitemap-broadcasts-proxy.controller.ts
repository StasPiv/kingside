/**
 * KS-4236. Edge-proxy для `apps/broadcast-service` admin-эндпоинта
 * `/admin/sitemap/broadcasts/regenerate`. broadcast-service внутри
 * VPC (`BROADCAST_SERVICE_URL`), на публичный URL не выставлен —
 * прокси проверяет `X-Admin-Token` и форвардит запрос.
 *
 * Двойная защита токеном: api проверяет → broadcast-service тоже
 * проверяет.
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

@Controller('admin/sitemap')
export class SitemapBroadcastsProxyController {
  private readonly logger = new Logger(SitemapBroadcastsProxyController.name);

  constructor(private readonly config: ConfigService) {}

  @Post('broadcasts/regenerate')
  async regenerateBroadcasts(
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
    const target = `${url.replace(/\/+$/, '')}/admin/sitemap/broadcasts/regenerate`;
    this.logger.log(`[sitemap-proxy] forwarding to ${target}`);
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
          `[sitemap-proxy] broadcast-service responded HTTP ${res.status}: ${text}`,
        );
        throw new HttpException(
          { upstream: res.status, body },
          HttpStatus.BAD_GATEWAY,
        );
      }
      this.logger.log(`[sitemap-proxy] done: ${text}`);
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
