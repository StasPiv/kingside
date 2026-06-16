/**
 * KS-4236 / ADR-128 §7.10. Генератор `sitemap-broadcasts.xml` для
 * `broadcast-service`. Sitemap-сервис в `apps/api` (KS-4209) не имеет
 * доступа к broadcast-БД (`@kingside/broadcasts-db`) — поэтому генератор
 * живёт здесь и пишет в тот же S3-bucket `kingside-prerender-store` по
 * ключу `sitemap-broadcasts.xml`. Корневой `sitemap.xml`-index (его
 * пишет `apps/api/SitemapService`) ссылается на этот файл.
 *
 * Окно «свежих» трансляций — 12 месяцев по `updatedAt` (совпадает с
 * политикой `apps/api/sitemap.service.ts`).
 *
 * Cron в `SitemapBroadcastsScheduler` — `'5 3 * * *' UTC`, на 5 минут
 * позже api-cron'а (`'0 3 * * *'`), чтобы запись index'а и его
 * children'ов не пересекалась.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { buildUrlset, type SitemapUrlEntry } from './sitemap-builder';

const DEFAULT_BUCKET = 'kingside-prerender-store';
const DEFAULT_REGION = 'eu-central-1';
const DEFAULT_BASE_URL = 'https://kingside.site';

/** 12 месяцев — то же окно, что в apps/api SitemapService. */
const TWELVE_MONTHS_MS = 12 * 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class SitemapBroadcastsService {
  private readonly logger = new Logger(SitemapBroadcastsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Собрать XML по текущей выборке broadcasts и опубликовать в S3.
   */
  async generateAndPublish(): Promise<{
    broadcasts: number;
    bytes: number;
    key: string;
  }> {
    const xml = await this.generateXml();
    const key = 'sitemap-broadcasts.xml';
    await this.publishToS3(key, xml);
    // Считаем кол-во URL'ов по `<url>` для удобства caller'а.
    const count = (xml.match(/<url>/g) ?? []).length;
    this.logger.log(
      `[sitemap-broadcasts] published key=${key} entries=${count} bytes=${xml.length}`,
    );
    return { broadcasts: count, bytes: xml.length, key };
  }

  async generateXml(): Promise<string> {
    const since = new Date(Date.now() - TWELVE_MONTHS_MS);
    const rows = await this.prisma.broadcast.findMany({
      where: { updatedAt: { gte: since } },
      orderBy: { updatedAt: 'desc' },
      take: 50_000,
      select: { id: true, updatedAt: true },
    });
    const base = this.baseUrl();
    const entries: SitemapUrlEntry[] = rows.map((r) => ({
      loc: `${base}/broadcasts/${r.id}`,
      lastmod: r.updatedAt,
      changefreq: 'hourly',
      priority: 0.7,
    }));
    return buildUrlset(entries);
  }

  private async publishToS3(key: string, body: string): Promise<void> {
    const sdk = await import('@aws-sdk/client-s3');
    const client = new sdk.S3Client({ region: this.region() });
    try {
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: this.bucket(),
          Key: key,
          Body: body,
          ContentType: 'application/xml; charset=utf-8',
          CacheControl: 'public, max-age=3600',
        }),
      );
    } finally {
      client.destroy();
    }
  }

  private baseUrl(): string {
    const raw = this.config.get<string>('PUBLIC_BASE_URL') ?? DEFAULT_BASE_URL;
    return raw.replace(/\/+$/, '');
  }

  private bucket(): string {
    return this.config.get<string>('SITEMAP_S3_BUCKET') ?? DEFAULT_BUCKET;
  }

  private region(): string {
    return this.config.get<string>('AWS_REGION') ?? DEFAULT_REGION;
  }
}
