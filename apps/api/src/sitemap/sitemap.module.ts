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
import { SitemapAdminController } from './sitemap-admin.controller';
// KS-4486: автоматическая инвалидация CloudFront после S3-записи.
import { CloudFrontInvalidationService } from './cloudfront-invalidation.service';
// KS-4488: генераторы archive-games / archive-players берут данные
// из БД архива через `ArchivePrismaService` из `ArchiveModule`.
import { ArchiveModule } from '../archive/archive.module';

@Module({
  imports: [ConfigModule, ArchiveModule],
  controllers: [SitemapController, SitemapAdminController],
  providers: [SitemapService, SitemapScheduler, CloudFrontInvalidationService],
  exports: [SitemapService],
})
export class SitemapModule {}
