/**
 * KS-4236. Cron-генерация `sitemap-broadcasts.xml`.
 *
 * 03:05 UTC ежесуточно — на 5 минут позже cron'а
 * `apps/api/SitemapScheduler` (03:00 UTC), чтобы index и его child'ы
 * не пересекались (если index публикуется первым с lastmod на
 * текущий день, child broadcasts'ов появляется чуть позже — ничего
 * страшного, Google всё равно crawl'ит детей с задержкой).
 *
 * Фича-флаг `SITEMAP_BROADCASTS_ENABLED` (default `true`).
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SitemapBroadcastsService } from './sitemap.service';

@Injectable()
export class SitemapBroadcastsScheduler implements OnModuleInit {
  private readonly logger = new Logger(SitemapBroadcastsScheduler.name);

  constructor(
    private readonly sitemap: SitemapBroadcastsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled = this.enabled();
    this.logger.log(
      `sitemap-broadcasts cron registered (enabled=${enabled}, schedule=03:05 UTC daily)`,
    );
  }

  @Cron('5 3 * * *', { timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (!this.enabled()) {
      this.logger.log(
        'sitemap-broadcasts tick skipped (SITEMAP_BROADCASTS_ENABLED=false)',
      );
      return;
    }
    const start = Date.now();
    try {
      const result = await this.sitemap.generateAndPublish();
      this.logger.log(
        `sitemap-broadcasts tick done in ${Date.now() - start}ms: ` +
          `broadcasts=${result.broadcasts} bytes=${result.bytes}`,
      );
    } catch (e) {
      this.logger.error(
        `sitemap-broadcasts tick crashed in ${Date.now() - start}ms: ${
          (e as Error).message
        }`,
      );
    }
  }

  private enabled(): boolean {
    const raw = this.config.get<string>('SITEMAP_BROADCASTS_ENABLED');
    if (raw === undefined || raw === null || raw === '') return true;
    const v = raw.toString().toLowerCase();
    return v === 'true' || v === '1';
  }
}
