/**
 * KS-4233. Разовый admin-эндпоинт для запуска генерации sitemap'ов
 * без ожидания cron-расписания (03:00 UTC). Полезно после правки
 * builder'а / выборок, для немедленной перезаписи S3.
 *
 * Аутентификация — тот же `X-Admin-Token` что в KS-4221/KS-4227
 * (env `BROADCAST_ADMIN_TOKEN`).
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
import { SitemapService } from './sitemap.service';

@Controller('admin/sitemap')
export class SitemapAdminController {
  private readonly logger = new Logger(SitemapAdminController.name);

  constructor(
    private readonly sitemap: SitemapService,
    private readonly config: ConfigService,
  ) {}

  @Post('regenerate')
  async regenerate(
    @Headers('x-admin-token') token: string | undefined,
  ): Promise<{
    published: string[];
    failed: Array<{ name: string; error: string }>;
  }> {
    this.assertAuth(token);
    this.logger.log('[sitemap-admin] manual regenerate triggered');
    const result = await this.sitemap.generateAllAndPublish();
    this.logger.log(
      `[sitemap-admin] done: published=${result.published.length} failed=${result.failed.length}`,
    );
    return result;
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
