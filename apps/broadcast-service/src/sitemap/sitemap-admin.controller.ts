/**
 * KS-4236. Admin-эндпоинт для ручного запуска генерации
 * sitemap-broadcasts.xml без ожидания cron'а 03:05 UTC. Аутентификация
 * — тот же `X-Admin-Token` что в KS-4221 (env `BROADCAST_ADMIN_TOKEN`).
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
import { SitemapBroadcastsService } from './sitemap.service';

@Controller('admin/sitemap')
export class SitemapBroadcastsAdminController {
  private readonly logger = new Logger(SitemapBroadcastsAdminController.name);

  constructor(
    private readonly sitemap: SitemapBroadcastsService,
    private readonly config: ConfigService,
  ) {}

  @Post('broadcasts/regenerate')
  async regenerateBroadcasts(
    @Headers('x-admin-token') token: string | undefined,
  ): Promise<{ broadcasts: number; bytes: number; key: string }> {
    this.assertAuth(token);
    this.logger.log('[sitemap-admin] manual regenerate broadcasts triggered');
    return this.sitemap.generateAndPublish();
  }

  private assertAuth(token: string | undefined): void {
    const expected = this.config.get<string>('BROADCAST_ADMIN_TOKEN');
    if (!expected || !expected.trim()) {
      this.logger.error(
        '[sitemap-admin] BROADCAST_ADMIN_TOKEN is not configured',
      );
      throw new HttpException(
        'admin endpoint is not configured (BROADCAST_ADMIN_TOKEN missing)',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!token || token !== expected) {
      throw new HttpException('forbidden', HttpStatus.FORBIDDEN);
    }
  }
}
