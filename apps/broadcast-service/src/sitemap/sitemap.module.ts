/**
 * KS-4236. Модуль генерации `sitemap-broadcasts.xml`.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SitemapBroadcastsService } from './sitemap.service';
import { SitemapBroadcastsScheduler } from './sitemap.scheduler';
import { SitemapBroadcastsAdminController } from './sitemap-admin.controller';

@Module({
  imports: [ConfigModule],
  controllers: [SitemapBroadcastsAdminController],
  providers: [SitemapBroadcastsService, SitemapBroadcastsScheduler],
  exports: [SitemapBroadcastsService],
})
export class SitemapBroadcastsModule {}
