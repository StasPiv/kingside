/**
 * KS-4209 / ADR-128 §7.10 §10 #15. Модуль публикации sitemap'ов
 * в S3 + контроллер `/robots.txt`.
 *
 * - `SitemapService` — сборка XML + S3 PUT.
 * - `SitemapScheduler` — cron 03:00 UTC ежесуточно.
 * - `SitemapController` — `/robots.txt`.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SitemapService } from './sitemap.service';
import { SitemapScheduler } from './sitemap.scheduler';
import { SitemapController } from './sitemap.controller';

@Module({
  imports: [ConfigModule],
  controllers: [SitemapController],
  providers: [SitemapService, SitemapScheduler],
  exports: [SitemapService],
})
export class SitemapModule {}
